import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  LineCounter,
  type Node,
  parseAllDocuments,
  type Scalar,
  type ScalarTag,
} from "yaml";

/**
 * The server's own YAML reader. It must agree with Ansible, which parses YAML
 * 1.1 through PyYAML (design.md F5): `yes`/`no`/`on`/`off` are booleans and an
 * unquoted `0755` is the octal integer 493. So every document is read with
 * `version: "1.1"`, Ansible's `!vault` and `!unsafe` tags are understood, and
 * every node keeps its 1-based line number (tasks are reported as file:line).
 */

export interface YScalar {
  kind: "scalar";
  value: unknown;
  line: number;
  /** The source text as written (`off`, `"0644"`, `0755`), for YAML 1.1 hints. */
  raw: string;
  /** `!vault`, `!unsafe`, or undefined. */
  tag?: string;
}
export interface YEntry {
  key: string;
  keyLine: number;
  value: YNode;
}
export interface YMap {
  kind: "map";
  line: number;
  endLine: number;
  entries: YEntry[];
}
export interface YSeq {
  kind: "seq";
  line: number;
  endLine: number;
  items: YNode[];
}
export type YNode = YScalar | YMap | YSeq;

export interface YamlDoc {
  root: YNode | null;
  /** Parse errors (the document is still returned as far as it parsed). */
  errors: string[];
  /** Duplicate keys, which Ansible warns about (the last one wins). */
  duplicates: { key: string; line: number }[];
}

const vaultTag: ScalarTag = {
  tag: "!vault",
  identify: () => false,
  resolve: (str: string) => ({ __ansible_vault: str }),
};
const unsafeTag: ScalarTag = {
  tag: "!unsafe",
  identify: () => false,
  resolve: (str: string) => str,
};

/**
 * PyYAML's 1.1 booleans. The `yaml` package's 1.1 schema also reads bare
 * `y` / `n` as booleans; PyYAML (and so Ansible) keeps them as strings.
 */
const BOOL = "tag:yaml.org,2002:bool";
const pyTrue = {
  tag: BOOL,
  default: true,
  identify: (v: unknown) => v === true,
  test: /^(?:[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
  resolve: () => true,
} as unknown as ScalarTag;
const pyFalse = {
  tag: BOOL,
  default: true,
  identify: (v: unknown) => v === false,
  test: /^(?:[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
  resolve: () => false,
} as unknown as ScalarTag;

const NULL_SCALAR = (line: number): YScalar => ({ kind: "scalar", value: null, line, raw: "" });

/**
 * Resolved aliases share one converted node, so a walk over the tree visits an
 * anchored subtree once per alias: nested aliases ("billion laughs") grow that
 * exponentially. Past this many expanded nodes an alias reads as null and the
 * document carries an error starting with ALIAS_LIMIT_ERROR (callers that must
 * not miss content, like the R1 pre-scan, refuse such a file).
 */
const MAX_ALIAS_EXPANSION = 100_000;
export const ALIAS_LIMIT_ERROR = "alias expansion limit exceeded";

/** Parse every document in `src` (Ansible reads only the first for most files). */
export function parseYaml(src: string): YamlDoc {
  const lc = new LineCounter();
  const docs = parseAllDocuments(src, {
    version: "1.1",
    customTags: (tags) => [
      pyTrue,
      pyFalse,
      ...tags.filter((t) => (t as { tag?: string }).tag !== BOOL),
      vaultTag,
      unsafeTag,
    ],
    uniqueKeys: false,
    lineCounter: lc,
    keepSourceTokens: false,
    prettyErrors: false,
    merge: true,
  });
  const list = Array.isArray(docs) ? docs : [docs];
  const errors: string[] = [];
  const duplicates: { key: string; line: number }[] = [];
  const line = (offset: number | undefined) => (offset === undefined ? 0 : lc.linePos(offset).line);

  /**
   * Nodes already converted, so an anchored node is not converted twice (its
   * duplicate keys would be reported once per use). `inProgress` breaks a
   * self-referential merge or alias (`a: &a {<<: *a}`, `a: &a [*a]`), which
   * would otherwise recurse forever.
   */
  const convertedCache = new WeakMap<object, YNode>();
  const inProgress = new WeakSet<object>();
  /** Expanded node count of each converted node, charged to the alias budget on each alias use. */
  const sizes = new WeakMap<YNode, number>();
  let aliasBudget = MAX_ALIAS_EXPANSION;
  let aliasLimitHit = false;
  const sizeOf = (y: YNode): number => {
    const known = sizes.get(y);
    if (known !== undefined) return known;
    const n =
      y.kind === "scalar"
        ? 1
        : y.kind === "seq"
          ? y.items.reduce((a, i) => a + sizeOf(i), 1)
          : y.entries.reduce((a, e) => a + sizeOf(e.value), 1);
    sizes.set(y, n);
    return n;
  };

  /** Entries of a `<<:` merge value: one alias, or a sequence of them. */
  const mergeEntries = (node: unknown): YEntry[] => {
    const anchors = isAlias(node) ? [node] : isSeq(node as Node) ? (node as unknown as { items: unknown[] }).items : [];
    const out: YEntry[] = [];
    for (const a of anchors) {
      const target = isAlias(a) ? (a as { resolve(doc: unknown): Node | null }).resolve(docs[0]) : null;
      if (!target || !isMap(target)) continue;
      const conv = convert(target, line((target as Node).range?.[0]));
      if (conv.kind === "map") out.push(...conv.entries);
    }
    return out;
  };

  /**
   * An alias used as a mapping key (`*h : all` with `&h hosts`) reads as the
   * anchored scalar's text, as in PyYAML, through `convert` so the alias
   * budget applies. A non-scalar anchor (unhashable in PyYAML) keeps the text.
   */
  const aliasKey = (k: unknown, fallbackLine: number): string => {
    const conv = convert(k, fallbackLine);
    return conv.kind === "scalar" && conv.value !== null && typeof conv.value !== "object"
      ? String(conv.value)
      : String(k);
  };

  const convert = (node: unknown, fallbackLine: number): YNode => {
    if (node === null || node === undefined) return NULL_SCALAR(fallbackLine);
    if (isAlias(node)) {
      // Resolve aliases to the anchored node's value, as PyYAML does: the
      // lookup pre-scan (R1) must see `hosts: *h` as the anchored string. The
      // result keeps the anchor's line (where the text is); the cache shares
      // it, and `inProgress` breaks a self-referential alias (`a: &a [*a]`).
      const target = (node as { resolve(doc: unknown): Node | null | undefined }).resolve(docs[0]);
      const aliasLine = line((node as Node).range?.[0]);
      if (!target || aliasLimitHit) return NULL_SCALAR(aliasLine);
      const out = convert(target, aliasLine);
      aliasBudget -= sizeOf(out);
      if (aliasBudget < 0) {
        aliasLimitHit = true;
        return NULL_SCALAR(aliasLine);
      }
      return out;
    }
    const n = node as Node;
    const cached = convertedCache.get(n);
    if (cached) return cached;
    if (inProgress.has(n)) return NULL_SCALAR(line(n.range?.[0]));
    inProgress.add(n);
    const start = line(n.range?.[0]);
    if (isScalar(n)) {
      const s = n as Scalar;
      const raw = n.range ? src.slice(n.range[0], n.range[1]) : String(s.value);
      const out: YNode = {
        kind: "scalar",
        value: s.value,
        line: start,
        raw,
        ...(s.tag === "!vault" || s.tag === "!unsafe" ? { tag: s.tag } : {}),
      };
      inProgress.delete(n);
      convertedCache.set(n, out);
      return out;
    }
    if (isMap(n)) {
      const entries: YEntry[] = [];
      const seen = new Set<string>();
      const merged: YEntry[] = [];
      const explicit: string[] = [];
      for (const item of n.items) {
        if (!isPair(item)) continue;
        const k = item.key as Node | null;
        // `<<: *anchor` merge key. The key scalar's value is a symbol, and the
        // value is an Alias to a map. PyYAML (and so Ansible) expands it, with
        // the map's own keys overriding the merged ones.
        if (isScalar(k) && typeof (k as Scalar).value === "symbol") {
          for (const e of mergeEntries(item.value)) merged.push(e);
          continue;
        }
        const keyText = isScalar(k)
          ? String((k as Scalar).value)
          : isAlias(k)
            ? aliasKey(k, start)
            : k
              ? String(k)
              : "";
        const keyLine = line(k?.range?.[0]) || start;
        if (seen.has(keyText)) duplicates.push({ key: keyText, line: keyLine });
        seen.add(keyText);
        explicit.push(keyText);
        entries.push({ key: keyText, keyLine, value: convert(item.value, keyLine) });
      }
      // Merged entries come first so the last-wins lookup picks the explicit one.
      for (const e of merged) if (!explicit.includes(e.key)) entries.unshift(e);
      const out: YNode = { kind: "map", line: start, endLine: endLine(n, start), entries };
      inProgress.delete(n);
      convertedCache.set(n, out);
      return out;
    }
    if (isSeq(n)) {
      const out: YNode = {
        kind: "seq",
        line: start,
        endLine: endLine(n, start),
        items: n.items.map((it) => convert(it, start)),
      };
      inProgress.delete(n);
      convertedCache.set(n, out);
      return out;
    }
    inProgress.delete(n);
    return NULL_SCALAR(start);
  };

  const endLine = (n: Node, start: number): number => {
    const r = n.range;
    if (!r) return start;
    // range[1] is the end of the value; a trailing newline belongs to the next line.
    let end = r[1];
    while (end > r[0] && /\s/.test(src[end - 1] ?? "")) end--;
    return line(end) || start;
  };

  let root: YNode | null = null;
  for (const [i, d] of list.entries()) {
    for (const e of d.errors) errors.push(e.message.split("\n")[0]!);
    if (i === 0) root = d.contents ? convert(d.contents, 1) : null;
  }
  if (aliasLimitHit) errors.push(`${ALIAS_LIMIT_ERROR} (more than ${MAX_ALIAS_EXPANSION} nodes through aliases)`);
  return { root, errors, duplicates };
}

/** Plain JS value of a node (vault -> {__ansible_vault}, maps -> objects). */
export function toJS(node: YNode | null | undefined): unknown {
  if (!node) return null;
  if (node.kind === "scalar") return node.value;
  if (node.kind === "seq") return node.items.map(toJS);
  const out: Record<string, unknown> = {};
  for (const e of node.entries) out[e.key] = toJS(e.value);
  return out;
}

export function getEntry(map: YNode | null | undefined, key: string): YEntry | undefined {
  if (map?.kind !== "map") return undefined;
  // Last one wins, as in Ansible.
  for (let i = map.entries.length - 1; i >= 0; i--) if (map.entries[i]!.key === key) return map.entries[i];
  return undefined;
}

export function get(map: YNode | null | undefined, key: string): YNode | undefined {
  return getEntry(map, key)?.value;
}

export function scalarString(node: YNode | undefined): string | undefined {
  if (node?.kind !== "scalar" || node.value === null || node.value === undefined) return undefined;
  return typeof node.value === "object" ? undefined : String(node.value);
}

/** A string that Ansible would template (`{{ }}` or `{% %}`). */
export function isTemplated(v: unknown): boolean {
  return typeof v === "string" && /\{\{|\{%/.test(v);
}

/** YAML 1.1 booleans as written, e.g. `off`, `Yes`. */
export function isYaml11BoolWord(raw: string): boolean {
  return /^(yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF)$/.test(raw.trim());
}

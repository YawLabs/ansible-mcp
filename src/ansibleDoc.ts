import { redactStandalone } from "./redact.js";

/**
 * `ansible-doc --json` output (design.md F1, F2). Pure parsing and rendering.
 *
 * The JSON key is the name exactly as asked (`apt`), so the resolved FQCN comes
 * from `doc.plugin_name`, the collection from `doc.collection`, and the path
 * that won from `doc.filename`. A missing plugin is exit 0 + `{}` + a
 * "was not found" warning; a tombstoned one is exit 1 with an [ERROR], and one
 * tombstone in a batch fails the whole batch.
 */

export interface DocOption {
  type?: string;
  required?: boolean;
  default?: unknown;
  choices?: unknown[] | Record<string, unknown>;
  aliases?: string[];
  elements?: string;
  suboptions?: Record<string, DocOption>;
  /** Role argument specs nest with `options`. */
  options?: Record<string, DocOption>;
  deprecated?: unknown;
  no_log?: boolean;
  version_added?: string;
  version_added_collection?: string;
  description?: string | string[];
}

export interface PluginDoc {
  /** The name as asked. */
  key: string;
  fqcn: string;
  collection: string;
  filename: string;
  hasAction: boolean;
  shortDescription: string;
  description: string;
  options: Record<string, DocOption>;
  deprecated?: { removed_in?: string; why?: string; alternative?: string; removed_from_collection?: string };
  checkMode?: string;
  requirements: string[];
  returns: Record<string, { description?: string | string[]; type?: string; returned?: string }> | null;
  examples: string;
  versionAdded?: string;
}

const asText = (d: unknown): string =>
  Array.isArray(d)
    ? d.map(String).join(" ")
    : typeof d === "string"
      ? d
      : d === undefined || d === null
        ? ""
        : String(d);

export function parseDocJson(text: string): Map<string, PluginDoc> {
  const out = new Map<string, PluginDoc>();
  const t = text.trim();
  if (!t) return out;
  let data: Record<string, any>;
  try {
    data = JSON.parse(t);
  } catch (e) {
    throw new Error(`ansible-doc --json did not return JSON (${e instanceof Error ? e.message : String(e)}).`);
  }
  for (const [key, entry] of Object.entries(data ?? {})) {
    const doc = entry?.doc;
    if (!doc || typeof doc !== "object") continue;
    out.set(key, {
      key,
      fqcn: String(doc.plugin_name ?? key),
      collection: String(doc.collection ?? ""),
      filename: String(doc.filename ?? ""),
      hasAction: doc.has_action === true,
      shortDescription: asText(doc.short_description),
      description: asText(doc.description),
      options: (doc.options ?? {}) as Record<string, DocOption>,
      deprecated: doc.deprecated && typeof doc.deprecated === "object" ? doc.deprecated : undefined,
      checkMode: doc.attributes?.check_mode?.support,
      requirements: Array.isArray(doc.requirements) ? doc.requirements.map(String) : [],
      returns: entry.return && typeof entry.return === "object" ? entry.return : null,
      examples: typeof entry.examples === "string" ? entry.examples : "",
      versionAdded: doc.version_added,
    });
  }
  return out;
}

export interface Tombstone {
  name: string;
  text: string;
  collection: string;
  version: string;
}

export interface DocStderr {
  missing: string[];
  /** Deprecation warnings that name a plugin (`<name> has been deprecated. <text>`). */
  deprecations: { name: string; text: string }[];
  tombstones: Tombstone[];
  /** Other [ERROR] lines. */
  errors: string[];
}

const TOMBSTONE =
  /\[ERROR\]: (?:\w+ )?(\S+) Missing documentation \(or could not parse documentation\): (?:The '[^']+' \w+ has been removed\. )?(.*?) ?This feature was removed from collection '([^']+)' version ([^\s]+?)\.?$/;

export function classifyDocStderr(stderr: string): DocStderr {
  const r: DocStderr = { missing: [], deprecations: [], tombstones: [], errors: [] };
  for (const line of stderr.split(/\r?\n/)) {
    let m = /^\[WARNING\]: (\S+) was not found$/.exec(line);
    if (m) {
      if (!r.missing.includes(m[1]!)) r.missing.push(m[1]!);
      continue;
    }
    m = /^\[DEPRECATION WARNING\]: (\S+) has been deprecated\. (.*)$/.exec(line);
    if (m) {
      r.deprecations.push({ name: m[1]!, text: m[2]! });
      continue;
    }
    m = TOMBSTONE.exec(line);
    if (m) {
      if (!r.tombstones.some((t) => t.name === m![1])) {
        r.tombstones.push({ name: m[1]!, text: m[2]!.trim(), collection: m[3]!, version: m[4]! });
      }
      continue;
    }
    if (line.startsWith("[ERROR]:")) r.errors.push(line.slice(9).trim());
  }
  return r;
}

/** Normalize an option's choices (a list, or a dict of choice -> description). */
export function choicesOf(o: DocOption | undefined): unknown[] | null {
  if (!o?.choices) return null;
  return Array.isArray(o.choices) ? o.choices : Object.keys(o.choices);
}

export function subOptionsOf(o: DocOption | undefined): Record<string, DocOption> | null {
  return o?.suboptions ?? o?.options ?? null;
}

/** The type Ansible applies when `type` is missing. */
export const typeOf = (o: DocOption | undefined): string => o?.type ?? "str";

/** Find an option by name or alias. Returns [canonical name, spec, matchedAlias?]. */
export function findOption(
  options: Record<string, DocOption>,
  name: string,
): [string, DocOption, string | undefined] | null {
  if (Object.hasOwn(options, name)) return [name, options[name]!, undefined];
  for (const [k, o] of Object.entries(options)) {
    if (o.aliases?.includes(name)) return [k, o, name];
  }
  return null;
}

function oneLine(desc: unknown, max: number): string {
  let d = asText(desc).replace(/\s+/g, " ").trim();
  if (max && d.length > max) d = `${d.slice(0, max)}...`;
  return d;
}

function optionLine(name: string, o: DocOption, pad: string, descLen: number, majorFloor: string | null): string {
  const t = typeOf(o);
  const type = o.elements ? `${t} of ${o.elements}` : t;
  const flags: string[] = [];
  if (o.required) flags.push("[required]");
  if (o.default !== undefined && o.default !== null)
    flags.push(o.no_log ? "[default: (no_log)]" : `[default: ${redactStandalone(o.default, name)}]`);
  const ch = choicesOf(o);
  if (ch) flags.push(`[choices: ${ch.map((c) => String(c)).join("|")}]`);
  if (o.aliases?.length) flags.push(`[aliases: ${o.aliases.join(", ")}]`);
  if (o.no_log) flags.push("[no_log]");
  if (o.deprecated) {
    const d = o.deprecated as Record<string, unknown>;
    flags.push(
      `[deprecated${d.removed_in ? `: removed in ${d.removed_in}` : ""}${d.alternative ? `, ${oneLine(d.alternative, 80)}` : ""}]`,
    );
  }
  if (o.version_added && majorFloor && o.version_added_collection && newerThan(o.version_added, majorFloor)) {
    flags.push(`[added in ${o.version_added_collection} ${o.version_added}]`);
  }
  const desc = oneLine(o.description, descLen);
  return `${pad}${name} (${type})${flags.length ? ` ${flags.join(" ")}` : ""}${desc ? ` - ${desc}` : ""}`;
}

function newerThan(v: string, floor: string): boolean {
  const a = String(v).split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export function renderOptions(
  options: Record<string, DocOption>,
  depth: number,
  descLen: number,
  majorFloor: string | null,
): string[] {
  const lines: string[] = [];
  const pad = "  ".repeat(depth);
  for (const name of Object.keys(options).sort()) {
    const o = options[name]!;
    lines.push(optionLine(name, o, pad, descLen, majorFloor));
    const sub = subOptionsOf(o);
    if (sub) lines.push(...renderOptions(sub, depth + 1, descLen, majorFloor));
  }
  return lines;
}

export interface ModuleDocRender {
  doc: PluginDoc;
  type: string;
  asked: string;
  /** e.g. "community.general 9.5.2" or "ansible-core 2.21.5". */
  source: string;
  includeReturn: boolean;
  includeExamples: boolean;
  descriptionChars: number;
  /** x.0.0 of the installed major, for `[added in ...]` flags. */
  majorFloor: string | null;
}

export function renderModuleDoc(r: ModuleDocRender): string {
  const d = r.doc;
  const resolved = r.asked !== d.fqcn ? ` [resolved from '${r.asked}']` : "";
  let head = `${d.fqcn} (${r.type}, ${r.source})${resolved}`;
  if (d.deprecated) {
    const dep = d.deprecated;
    head += ` [DEPRECATED${dep.removed_in ? `: removed in ${dep.removed_in}` : ""}${dep.why ? `; ${oneLine(dep.why, 120)}` : ""}${dep.alternative ? `; ${oneLine(dep.alternative, 120)}` : ""}]`;
  }
  if (d.hasAction) head += " [has action plugin]";
  if (d.shortDescription) head += ` - ${d.shortDescription}`;
  const lines = [head];
  const meta: string[] = [];
  if (d.checkMode) meta.push(`check_mode: ${d.checkMode}`);
  if (d.requirements.length) meta.push(`requirements: ${d.requirements.join("; ")}`);
  if (meta.length) lines.push(meta.join(" | "));
  const opts = d.options ?? {};
  lines.push(`options (${Object.keys(opts).length}):`);
  lines.push(...renderOptions(opts, 1, r.descriptionChars, r.majorFloor));
  if (r.type === "module") {
    lines.push(
      "not in ansible-doc output: cross-option rules (mutually_exclusive, required_if, ...); see the module description and notes",
    );
  }
  if (r.includeReturn && r.type === "module") {
    const ret = Object.entries(d.returns ?? {});
    if (ret.length === 0) {
      lines.push("returns: (none documented)");
    } else {
      lines.push(`returns (${ret.length}):`);
      for (const [k, v] of ret.sort(([a], [b]) => (a < b ? -1 : 1))) {
        const desc = oneLine(v?.description, r.descriptionChars);
        lines.push(
          `  ${k} (${v?.type ?? "?"}${v?.returned ? `, ${oneLine(v.returned, 40)}` : ""})${desc ? ` - ${desc}` : ""}`,
        );
      }
    }
  }
  if (r.includeExamples && d.examples.trim()) {
    lines.push("examples:");
    lines.push(...d.examples.replace(/^\n+|\s+$/g, "").split("\n"));
  }
  return lines.join("\n");
}

/** `<root>/ansible_collections/<ns>/<name>/...` -> `<root>/ansible_collections/<ns>/<name>`. */
export function collectionRootOf(filename: string): string | null {
  const m = /^(.*\/ansible_collections\/[^/]+\/[^/]+)\//.exec(filename.replace(/\\/g, "/"));
  return m ? m[1]! : null;
}

/** `<root>/ansible_collections/<ns>/<name>/...` -> `<root>` (the collections path entry). */
export function collectionsPathOf(filename: string): string | null {
  const m = /^(.*)\/ansible_collections\//.exec(filename.replace(/\\/g, "/"));
  return m ? m[1]! : null;
}

export const PLUGIN_TYPES = [
  "module",
  "lookup",
  "filter",
  "test",
  "callback",
  "connection",
  "inventory",
  "become",
  "cache",
  "vars",
  "strategy",
  "shell",
  "cliconf",
  "httpapi",
  "netconf",
  "keyword",
  "role",
] as const;

export function isPluginType(t: string): boolean {
  return (PLUGIN_TYPES as readonly string[]).includes(t);
}

export const BAD_TYPE_MESSAGE = `type must be one of ${PLUGIN_TYPES.join(", ")}`;

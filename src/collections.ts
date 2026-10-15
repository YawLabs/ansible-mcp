import { ConstraintSyntaxError, satisfies } from "./constraints.js";
import { get, scalarString, type YNode } from "./yaml.js";

/**
 * ansible_collections (design.md 7.9): requirements files vs what is
 * installed, with galaxy constraint semantics and COLLECTIONS_PATHS order for
 * the effective version (F12: `collection list` prints paths out of order).
 * Pure.
 */

export interface Requirement {
  name: string;
  version?: string;
  type?: string;
  source?: string;
  line: number;
  file: string;
}

export interface Requirements {
  collections: Requirement[];
  roles: Requirement[];
}

export function parseRequirements(root: YNode | null | undefined, file: string): Requirements {
  const out: Requirements = { collections: [], roles: [] };
  const entries = (seq: YNode | undefined, into: Requirement[]) => {
    if (seq?.kind !== "seq") return;
    for (const item of seq.items) {
      if (item.kind === "scalar" && typeof item.value === "string") {
        // `name` or `name,version` (legacy role form).
        const [n, v] = item.value.split(",").map((s) => s.trim());
        into.push({ name: n!, ...(v ? { version: v } : {}), line: item.line, file });
      } else if (item.kind === "map") {
        const name = scalarString(get(item, "name")) ?? scalarString(get(item, "src"));
        if (!name) continue;
        const r: Requirement = { name, line: item.line, file };
        const v = scalarString(get(item, "version"));
        if (v !== undefined) r.version = v;
        const t = scalarString(get(item, "type")) ?? scalarString(get(item, "scm"));
        if (t !== undefined) r.type = t;
        const s = scalarString(get(item, "source"));
        if (s !== undefined) r.source = s;
        into.push(r);
      }
    }
  };
  if (root?.kind === "seq") {
    entries(root, out.roles);
  } else if (root?.kind === "map") {
    entries(get(root, "collections"), out.collections);
    entries(get(root, "roles"), out.roles);
  }
  return out;
}

export interface Installed {
  /** The `.../ansible_collections` path as printed. */
  path: string;
  name: string;
  version: string;
}

export function parseCollectionList(text: string): Installed[] {
  const t = text.trim();
  if (!t) return [];
  let data: Record<string, Record<string, { version?: string }>>;
  try {
    data = JSON.parse(t);
  } catch {
    throw new Error("ansible-galaxy collection list --format json did not return JSON.");
  }
  const out: Installed[] = [];
  for (const [path, colls] of Object.entries(data ?? {})) {
    for (const [name, info] of Object.entries(colls ?? {})) {
      out.push({ path, name, version: String(info?.version ?? "*") });
    }
  }
  return out;
}

/**
 * All installed copies of each collection, effective (first) first: paths in
 * COLLECTIONS_PATHS order, then anything else (site-packages, playbook-adjacent).
 */
export function byCollection(installed: Installed[], collectionsPaths: string[]): Map<string, Installed[]> {
  const rank = (p: string) => {
    const base = p.replace(/\/ansible_collections\/?$/, "");
    const i = collectionsPaths.findIndex((c) => c.replace(/\/+$/, "") === base);
    return i < 0 ? collectionsPaths.length : i;
  };
  const out = new Map<string, Installed[]>();
  for (const i of installed) {
    const list = out.get(i.name) ?? [];
    list.push(i);
    out.set(i.name, list);
  }
  for (const list of out.values()) list.sort((a, b) => rank(a.path) - rank(b.path));
  return out;
}

export interface RoleListEntry {
  path: string;
  name: string;
  version: string;
}

/** `ansible-galaxy role list` (text only, F12): `# <path>` then `- name, version`, blocks may repeat. */
export function parseRoleList(text: string): RoleListEntry[] {
  const out: RoleListEntry[] = [];
  let path = "";
  for (const raw of text.split(/\r?\n/)) {
    const h = /^# (.+)$/.exec(raw.trim());
    if (h) {
      path = h[1]!;
      continue;
    }
    const m = /^- ([^,]+),\s*(.*)$/.exec(raw.trim());
    if (m && !out.some((e) => e.path === path && e.name === m[1]!.trim())) {
      out.push({ path, name: m[1]!.trim(), version: m[2]!.trim() });
    }
  }
  return out;
}

export type ReqStatus =
  | { kind: "ok"; version: string }
  | { kind: "violates"; version: string }
  | { kind: "missing" }
  | { kind: "unchecked"; why: string };

export function checkRequirement(req: Requirement, installedVersion: string | null, isRole = false): ReqStatus {
  if (req.type && req.type !== "galaxy" && !isRole) return { kind: "unchecked", why: `type ${req.type}` };
  if (installedVersion === null) return { kind: "missing" };
  if (!req.version || req.version === "*") return { kind: "ok", version: installedVersion };
  if (isRole) {
    return req.version === installedVersion || installedVersion === "(unknown version)"
      ? { kind: "ok", version: installedVersion }
      : { kind: "violates", version: installedVersion };
  }
  try {
    return satisfies(installedVersion, req.version)
      ? { kind: "ok", version: installedVersion }
      : { kind: "violates", version: installedVersion };
  } catch (e) {
    if (e instanceof ConstraintSyntaxError) return { kind: "unchecked", why: e.message };
    throw e;
  }
}

export interface CollectionsReport {
  reqFiles: { file: string; reqs: Requirements }[];
  installed: Map<string, Installed[]>;
  roles: RoleListEntry[];
  collectionsPaths: string[];
  includeExtras: boolean;
  display: (p: string) => string;
}

export function renderCollections(r: CollectionsReport): string {
  const lines: string[] = [];
  const paths = r.collectionsPaths.map(r.display).join(", ") || "(none)";
  let ok = 0;
  let bad = 0;
  let missing = 0;
  const required = new Set<string>();
  if (r.reqFiles.length === 0) {
    lines.push(
      `no requirements file (looked for requirements.yml, collections/requirements.yml, roles/requirements.yml); collections paths: ${paths}`,
    );
  }
  for (const { file, reqs } of r.reqFiles) {
    lines.push(
      `${file}: ${reqs.collections.length} collection${reqs.collections.length === 1 ? "" : "s"}, ${reqs.roles.length} role${reqs.roles.length === 1 ? "" : "s"} (collections paths: ${paths})`,
    );
    if (reqs.collections.length) lines.push("collections:");
    for (const q of reqs.collections) {
      required.add(q.name);
      const inst = r.installed.get(q.name)?.[0];
      const st = checkRequirement(q, inst?.version ?? null);
      const label = `  ${q.name}${q.version ? ` ${q.version}` : ""}`;
      if (st.kind === "ok") {
        ok++;
        lines.push(`${label}: installed ${st.version} ok`);
      } else if (st.kind === "violates") {
        bad++;
        lines.push(`${label}: installed ${st.version} VIOLATES (${file}:${q.line})`);
      } else if (st.kind === "missing") {
        missing++;
        lines.push(`${label}: MISSING (${file}:${q.line})`);
      } else {
        lines.push(`${label}: not checked (${st.why})`);
      }
    }
    if (reqs.roles.length) lines.push("roles:");
    for (const q of reqs.roles) {
      const inst = r.roles.find((e) => e.name === q.name);
      const st = checkRequirement(q, inst?.version ?? null, true);
      const label = `  ${q.name}${q.version ? ` ${q.version}` : ""}`;
      if (st.kind === "ok") {
        ok++;
        lines.push(`${label}: installed ${st.version} ok`);
      } else if (st.kind === "violates") {
        bad++;
        lines.push(`${label}: installed ${st.version} VIOLATES (${file}:${q.line})`);
      } else if (st.kind === "missing") {
        missing++;
        lines.push(`${label}: MISSING (${file}:${q.line})`);
      } else {
        lines.push(`${label}: not checked (${st.why})`);
      }
    }
  }
  const shadowed = [...r.installed.entries()].filter(([, list]) => list.length > 1);
  if (shadowed.length === 0) {
    lines.push("shadowed: (none)");
  } else {
    lines.push("shadowed:");
    for (const [name, list] of shadowed) {
      const [first, ...rest] = list;
      lines.push(
        `  ${name}: ${first!.version} at ${r.display(first!.path)} (effective, first in COLLECTIONS_PATHS), also ${rest.map((x) => `${x.version} at ${r.display(x.path)}`).join(", ")}`,
      );
    }
  }
  const extras = [...r.installed.entries()].filter(([n]) => !required.has(n));
  const bundle = extras.filter(([, l]) => /site-packages\/ansible_collections/.test(l[0]!.path));
  const own = extras.filter(([, l]) => !/site-packages\/ansible_collections/.test(l[0]!.path));
  if (r.includeExtras) {
    if (own.length) {
      lines.push(`installed, not required (${own.length}):`);
      for (const [n, l] of own.sort(([a], [b]) => (a < b ? -1 : 1))) lines.push(`  ${n} ${l[0]!.version}`);
    }
  } else if (own.length) {
    lines.push(`installed, not required: ${own.length} (pass include_extras to list them)`);
  }
  if (bundle.length) lines.push(`${bundle.length} collections from the ansible package (site-packages)`);
  if (r.reqFiles.length) {
    lines.push(`summary: ${ok} ok, ${bad} violation${bad === 1 ? "" : "s"}, ${missing} missing`);
  }
  return lines.join("\n");
}

/** The effective installed version of one collection, or null. */
export function effectiveVersion(installed: Installed[], name: string, collectionsPaths: string[]): Installed | null {
  return byCollection(installed, collectionsPaths).get(name)?.[0] ?? null;
}

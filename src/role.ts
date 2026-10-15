import { readdirSync } from "node:fs";
import { join } from "node:path";
import { choicesOf, type DocOption, subOptionsOf, typeOf } from "./ansibleDoc.js";
import { findMain, isDir, isFile, type ProjectFiles, type RoleDep, roleDependencies } from "./project.js";
import { NO_LOG, Redactor } from "./redact.js";
import { get, getEntry, isYaml11BoolWord, toJS, type YNode } from "./yaml.js";

/**
 * ansible_role_interface (design.md 7.5): a role's argument specs (from
 * ansible-doc, or meta/argument_specs.yml read directly), its defaults
 * (redacted; `no_log` options print `(no_log)`), dependencies and vars names.
 * Pure apart from reading the role's own files.
 */

export interface EntryPoint {
  short_description?: string;
  description?: string | string[];
  options: Record<string, DocOption>;
}

export type RoleSpecs = Record<string, EntryPoint>;

/** `ansible-doc --json -t role` -> entry points. */
export function roleSpecsFromDocJson(
  text: string,
  role: string,
): { specs: RoleSpecs; collection: string | null } | null {
  let data: Record<string, any>;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const entry = data?.[role] ?? Object.values(data ?? {})[0];
  if (!entry?.entry_points) return null;
  const specs: RoleSpecs = {};
  for (const [ep, v] of Object.entries(entry.entry_points as Record<string, any>)) {
    specs[ep] = { short_description: v?.short_description, description: v?.description, options: v?.options ?? {} };
  }
  return { specs, collection: entry.collection ?? null };
}

/** meta/argument_specs.yml (or `argument_specs:` in meta/main.yml) read with the YAML 1.1 reader. */
export function roleSpecsFromNode(root: YNode | null | undefined): RoleSpecs | null {
  const specs = get(root, "argument_specs");
  if (specs?.kind !== "map") return null;
  const out: RoleSpecs = {};
  for (const e of specs.entries) {
    const v = toJS(e.value) as Record<string, any> | null;
    out[e.key] = { short_description: v?.short_description, description: v?.description, options: v?.options ?? {} };
  }
  return out;
}

export interface Yaml11Choice {
  entryPoint: string;
  option: string;
  value: boolean;
  raw: string;
}

/** Choices that YAML 1.1 turned into booleans (`off` -> false, F5). */
export function yaml11Choices(root: YNode | null | undefined): Yaml11Choice[] {
  const out: Yaml11Choice[] = [];
  const specs = get(root, "argument_specs");
  if (specs?.kind !== "map") return out;
  const walk = (ep: string, opts: YNode | undefined, prefix: string) => {
    if (opts?.kind !== "map") return;
    for (const o of opts.entries) {
      const ch = get(o.value, "choices");
      if (ch?.kind === "seq") {
        for (const c of ch.items) {
          if (c.kind === "scalar" && typeof c.value === "boolean" && isYaml11BoolWord(c.raw)) {
            out.push({ entryPoint: ep, option: `${prefix}${o.key}`, value: c.value, raw: c.raw.trim() });
          }
        }
      }
      walk(ep, get(o.value, "options") ?? get(o.value, "suboptions"), `${prefix}${o.key}.`);
    }
  };
  for (const ep of specs.entries) walk(ep.key, get(ep.value, "options"), "");
  return out;
}

/** Defaults as {name: value} from defaults/main.yml, main.yaml, or a defaults/main/ directory. */
export function readDefaults(
  roleDir: string,
  files: ProjectFiles,
): { file: string; values: Record<string, unknown> } | null {
  const main = findMain(roleDir, "defaults");
  if (main) {
    const v = toJS(files.read(main)?.root);
    return {
      file: files.rel(main).split("/").slice(-2).join("/"),
      values: v && typeof v === "object" ? (v as Record<string, unknown>) : {},
    };
  }
  const dir = join(roleDir, "defaults", "main");
  if (!isDir(dir)) return null;
  const values: Record<string, unknown> = {};
  for (const f of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(f)) continue;
    const v = toJS(files.read(join(dir, f))?.root);
    if (v && typeof v === "object") Object.assign(values, v);
  }
  return { file: "defaults/main/", values };
}

function readVarsNames(roleDir: string, files: ProjectFiles): string[] {
  const main = findMain(roleDir, "vars");
  if (!main) return [];
  const root = files.read(main)?.root;
  return root?.kind === "map" ? root.entries.map((e) => e.key) : [];
}

function oneLine(desc: unknown, max: number): string {
  let d = (Array.isArray(desc) ? desc.join(" ") : String(desc ?? "")).replace(/\s+/g, " ").trim();
  if (max && d.length > max) d = `${d.slice(0, max)}...`;
  return d;
}

function optionLines(
  opts: Record<string, DocOption>,
  depth: number,
  descLen: number,
  defaults: Record<string, unknown>,
  warnings: Yaml11Choice[],
  ep: string,
  prefix: string,
): string[] {
  const lines: string[] = [];
  const pad = "  ".repeat(depth);
  const names = Object.keys(opts).sort((a, b) => {
    const ra = opts[a]!.required ? 0 : 1;
    const rb = opts[b]!.required ? 0 : 1;
    return ra - rb || (a < b ? -1 : a > b ? 1 : 0);
  });
  for (const name of names) {
    const o = opts[name]!;
    const t = typeOf(o);
    const type = o.elements ? `${t} of ${o.elements}` : t;
    const flags: string[] = [];
    if (o.required) flags.push("[required]");
    if (o.default !== undefined && o.default !== null)
      flags.push(o.no_log ? "[default: (no_log)]" : `[default: ${JSON.stringify(o.default)}]`);
    const ch = choicesOf(o);
    if (ch) flags.push(`[choices: ${ch.map(String).join("|")}]`);
    if (o.no_log) flags.push("[no_log]");
    if (depth === 1 && o.required && Object.hasOwn(defaults, name))
      flags.push("[required but has a default in defaults/main.yml]");
    const desc = oneLine(o.description, descLen);
    lines.push(`${pad}${name} (${type})${flags.length ? ` ${flags.join(" ")}` : ""}${desc ? ` - ${desc}` : ""}`);
    for (const w of warnings.filter((x) => x.entryPoint === ep && x.option === `${prefix}${name}`)) {
      lines.push(
        `${pad}  WARNING choice ${w.value} comes from unquoted '${w.raw}' in meta/argument_specs.yml (YAML 1.1); quote it`,
      );
    }
    const sub = subOptionsOf(o);
    if (sub) lines.push(...optionLines(sub, depth + 1, descLen, {}, warnings, ep, `${prefix}${name}.`));
  }
  return lines;
}

export interface RoleRender {
  name: string;
  /** "local, roles/webapp" or "collection ns.c". */
  origin: string;
  specs: RoleSpecs | null;
  specsSource: string;
  roleDir: string | null;
  files: ProjectFiles | null;
  entryPoint?: string;
  descriptionChars: number;
  yaml11: Yaml11Choice[];
}

export function renderRole(r: RoleRender): string {
  const specs = r.specs ?? {};
  const eps = Object.keys(specs)
    .filter((e) => !r.entryPoint || e === r.entryPoint)
    .sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : a < b ? -1 : 1));
  const defaults = r.roleDir && r.files ? readDefaults(r.roleDir, r.files) : null;
  const deps: RoleDep[] = r.roleDir && r.files ? roleDependencies(r.roleDir, r.files) : [];
  const varsNames = r.roleDir && r.files ? readVarsNames(r.roleDir, r.files) : [];
  const nDefaults = Object.keys(defaults?.values ?? {}).length;
  const lines = [
    `role ${r.name} (${r.origin}): ${Object.keys(specs).length} entry point${Object.keys(specs).length === 1 ? "" : "s"}, ${nDefaults} default${nDefaults === 1 ? "" : "s"}, ${deps.length} dependenc${deps.length === 1 ? "y" : "ies"}`,
  ];
  if (!r.specs) lines.push(`argument_specs: none (${r.specsSource}); the role's interface is only its defaults`);
  if (r.entryPoint && eps.length === 0)
    lines.push(`entry point '${r.entryPoint}' not found (have: ${Object.keys(specs).join(", ") || "none"})`);
  for (const ep of eps) {
    const e = specs[ep]!;
    const sd = e.short_description ? ` - ${oneLine(e.short_description, r.descriptionChars)}` : "";
    lines.push(`entry point ${ep}${sd}`);
    lines.push(...optionLines(e.options ?? {}, 1, r.descriptionChars, defaults?.values ?? {}, r.yaml11, ep, ""));
  }
  if (defaults) {
    const noLog = new Set<string>();
    const documented = new Set<string>();
    for (const e of Object.values(specs)) {
      for (const [k, o] of Object.entries(e.options ?? {})) {
        documented.add(k);
        if (o.no_log) noLog.add(k);
      }
    }
    const red = new Redactor();
    for (const [k, v] of Object.entries(defaults.values)) {
      if (noLog.has(k)) {
        if (typeof v === "string") red.addSecret(v);
      } else red.learn(v, [k]);
    }
    lines.push(`defaults (${defaults.file}):`);
    for (const [k, v] of Object.entries(defaults.values)) {
      lines.push(`  ${k} = ${noLog.has(k) ? NO_LOG : red.render(v, [k])}`);
    }
    const undocumented = Object.keys(defaults.values).filter((k) => !documented.has(k));
    if (r.specs && undocumented.length) lines.push(`  [not in argument_specs: ${undocumented.join(", ")}]`);
    const f = red.footer();
    if (f) lines.push(f);
  } else if (r.roleDir) {
    lines.push("defaults: (none)");
  }
  if (varsNames.length) {
    lines.push(`vars (vars/main.yml, high precedence: play vars cannot override them): ${varsNames.join(", ")}`);
  }
  if (deps.length) {
    lines.push(
      `dependencies: ${deps.map((d) => `${d.name}${d.vars.length ? ` (vars: ${d.vars.join(", ")})` : ""}`).join(", ")}`,
    );
  }
  if (r.roleDir && r.files) {
    const meta = findMain(r.roleDir, "meta");
    const gi = meta ? get(r.files.read(meta)?.root, "galaxy_info") : undefined;
    const min = getEntry(gi, "min_ansible_version");
    const platforms = toJS(get(gi, "platforms"));
    const bits: string[] = [];
    if (min) bits.push(`min_ansible_version ${JSON.stringify(toJS(min.value))}`);
    if (Array.isArray(platforms) && platforms.length) {
      bits.push(
        `platforms ${platforms
          .map((p: any) => `${p?.name ?? "?"}${Array.isArray(p?.versions) ? ` ${p.versions.join("/")}` : ""}`)
          .join(", ")}`,
      );
    }
    if (bits.length) lines.push(`galaxy_info: ${bits.join("; ")}`);
  }
  return lines.join("\n");
}

/** Where a local role's argument specs live, if anywhere. */
export function argSpecsFile(roleDir: string): string | null {
  for (const f of ["argument_specs.yml", "argument_specs.yaml"]) {
    const p = join(roleDir, "meta", f);
    if (isFile(p)) return p;
  }
  return findMain(roleDir, "meta");
}

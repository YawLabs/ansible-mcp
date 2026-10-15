import { choicesOf, type DocOption, findOption, type PluginDoc, subOptionsOf, typeOf } from "./ansibleDoc.js";
import type { DocResult } from "./context.js";
import { type ArgEntry, isFreeForm, type WalkTask } from "./project.js";
import { hasSecretShape, isSecretKey, isVaultMarker } from "./redact.js";
import { isTemplated, isYaml11BoolWord, type YNode } from "./yaml.js";

/**
 * ansible_check_task_args (design.md 7.4): every task's arguments against the
 * INSTALLED module docs. ansible-doc cannot express cross-option rules or
 * argument_spec-only deprecations (F3), so this never claims "valid", and it
 * says what it could not check. Pure.
 */

export const NOT_CHECKED_FOOTER =
  "not checked: cross-option rules (mutually_exclusive, required_if, ...) and argument_spec-only deprecations " +
  "are not in ansible-doc output; ansible_lint_summary's args[module] covers them for modules without an action plugin.";

/** Doc names to ask ansible-doc for: the action as written, plus `collections:`-prefixed candidates. */
export function docNamesFor(tasks: WalkTask[]): string[] {
  const names = new Set<string>();
  for (const t of tasks) {
    if (!t.action) continue;
    names.add(t.action);
    if (!t.action.includes(".")) for (const c of t.collections) names.add(`${c}.${t.action}`);
  }
  return [...names];
}

export type Resolution =
  | { kind: "doc"; doc: PluginDoc; asked: string }
  | { kind: "missing"; asked: string; reason: string };

/** Resolve a task's action through the doc results (collections keyword first, as Ansible does). */
export function resolveTaskDoc(t: WalkTask, docs: DocResult): Resolution | null {
  if (!t.action) return null;
  const candidates = t.action.includes(".") ? [t.action] : [...t.collections.map((c) => `${c}.${t.action}`), t.action];
  for (const c of candidates) {
    const d = docs.docs.get(c);
    if (d) return { kind: "doc", doc: d, asked: c };
  }
  const tomb = docs.tombstones.find((x) => x.name === t.action || x.name.endsWith(`.${t.action}`));
  if (tomb) {
    return {
      kind: "missing",
      asked: t.action,
      reason: `removed from ${tomb.collection} in ${tomb.version}: ${tomb.text}`,
    };
  }
  const dep = docs.deprecations.find((x) => x.name === t.action);
  if (dep) {
    return {
      kind: "missing",
      asked: t.action,
      reason: `deprecated and not found: ${dep.text} (the collection it moved to is not installed)`,
    };
  }
  return { kind: "missing", asked: t.action, reason: "module/action not found in the installed collections" };
}

export function describeValue(v: unknown): string {
  if (typeof v === "string") return `'${v}'`;
  return JSON.stringify(v);
}

const BOOL_STRINGS = new Set(["yes", "no", "true", "false", "on", "off", "1", "0", "y", "n", "t", "f", "1.0", "0.0"]);

/** Would Ansible's type conversion accept this literal value? Returns an error phrase, or null. */
export function typeError(type: string, v: unknown): string | null {
  switch (type) {
    case "bool":
    case "boolean":
      if (typeof v === "boolean") return null;
      if (typeof v === "number") return v === 0 || v === 1 ? null : "a number that is not 0 or 1";
      if (typeof v === "string")
        return BOOL_STRINGS.has(v.trim().toLowerCase()) ? null : "a string that is not a boolean";
      return Array.isArray(v) ? "a list" : "a mapping";
    case "int":
      if (typeof v === "number") return Number.isInteger(v) ? null : "a float";
      if (typeof v === "string") return /^\s*[-+]?\d+\s*$/.test(v) ? null : "a string that is not an integer";
      if (typeof v === "boolean") return null;
      return Array.isArray(v) ? "a list" : "a mapping";
    case "float":
      if (typeof v === "number") return null;
      if (typeof v === "string")
        return /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v) ? null : "a string that is not a number";
      return typeof v === "boolean" ? null : Array.isArray(v) ? "a list" : "a mapping";
    case "list":
      if (Array.isArray(v)) return null;
      if (v !== null && typeof v === "object") return "a mapping";
      return null;
    case "dict":
      if (v !== null && typeof v === "object" && !Array.isArray(v)) return null;
      if (typeof v === "string") {
        const s = v.trim();
        if (s.startsWith("{") || /^[\w.-]+=/.test(s)) return null;
        return "a string that is neither key=value pairs nor JSON";
      }
      return Array.isArray(v) ? "a list" : `a ${typeof v}`;
    default:
      // str, path, raw, jsonarg, json, bytes, bits: Ansible converts.
      return null;
  }
}

interface CheckOut {
  unknown: string[];
  values: string[];
  missing: string[];
  deprecated: string[];
  templated: string[];
  aliases: string[];
}

function sensitive(label: string, spec: DocOption, v: unknown): boolean {
  return spec.no_log === true || isSecretKey(label) || (typeof v === "string" && hasSecretShape(v));
}

function checkValue(
  label: string,
  spec: DocOption,
  v: unknown,
  line: number,
  node: YNode | undefined,
  out: CheckOut,
): void {
  if (v === null || v === undefined) return;
  // A `!vault` value is `{__ansible_vault: ...}` and Ansible decrypts it at run
  // time: its type cannot be checked statically, and it must not be a
  // "got a mapping" false positive.
  if (isVaultMarker(v)) return;
  if (isTemplated(v)) {
    out.templated.push(label);
    return;
  }
  const type = typeOf(spec);
  const show = (x: unknown) => (sensitive(label, spec, x) ? "a value" : describeValue(x));
  const where = `${label} (line ${line})`;
  const raw = node?.kind === "scalar" ? node.raw.trim() : "";

  // mode as a YAML int: the classic octal bug.
  if (label.split(".").pop() === "mode" && typeof v === "number" && (type === "raw" || type === "str")) {
    if (/^0[0-7]+$/.test(raw)) {
      out.values.push(`mode ${raw} (line ${line}) is the octal integer ${v} in YAML 1.1; quote it ("${raw}")`);
    } else {
      out.values.push(
        `mode ${raw || v} (line ${line}) is the decimal integer ${v}; quote an octal string instead (e.g. "0${raw || v}")`,
      );
    }
    return;
  }

  const choices = choicesOf(spec);
  const elements = type === "list" ? (spec.elements ?? null) : null;
  const items = elements && Array.isArray(v) ? v : [v];
  if (choices && (type !== "list" || Array.isArray(v) || typeof v !== "object")) {
    const list = type === "list" && typeof v === "string" ? v.split(",").map((s) => s.trim()) : items;
    for (const item of list) {
      if (isTemplated(item)) continue;
      if (choices.some((c) => c === item || String(c) === String(item))) continue;
      if (typeof item === "boolean" && raw && isYaml11BoolWord(raw)) {
        out.values.push(
          `${where}: unquoted ${raw} is the boolean ${item} in YAML 1.1, not one of ${choices.map(String).join("|")}; quote it ("${raw}")`,
        );
      } else {
        out.values.push(`${where}: ${show(item)} is not one of ${choices.map(String).join("|")}`);
      }
    }
    if (type !== "list") return;
  }

  const err = typeError(type, v);
  if (err) {
    const scalar = typeof v === "string" || typeof v === "number";
    const detail = scalar && !sensitive(label, spec, v) ? ` (${describeValue(v)})` : "";
    out.values.push(`${where}: expected ${type}, got ${err}${detail}`);
    return;
  }
  if (type === "str" && typeof v === "boolean" && raw && isYaml11BoolWord(raw)) {
    out.values.push(
      `${where}: unquoted ${raw} becomes the boolean ${v} in YAML 1.1 (Ansible passes the string '${v ? "True" : "False"}'); quote it ("${raw}")`,
    );
  }
  if (type === "str" && typeof v === "number" && /^0[0-7]+$/.test(raw)) {
    out.values.push(`${where}: unquoted ${raw} is the octal integer ${v} in YAML 1.1; quote it ("${raw}")`);
  }

  if (elements && Array.isArray(v)) {
    const sub = subOptionsOf(spec);
    v.forEach((item, i) => {
      if (isTemplated(item)) {
        out.templated.push(`${label}[${i}]`);
        return;
      }
      if (elements === "dict" && sub && item && typeof item === "object" && !Array.isArray(item)) {
        checkObject(sub, item as Record<string, unknown>, `${label}[${i}]`, line, nodeItem(node, i), out);
        return;
      }
      const e = typeError(elements, item);
      if (e) out.values.push(`${label}[${i}] (line ${line}): expected ${elements}, got ${e}`);
    });
    return;
  }
  const sub = subOptionsOf(spec);
  if (sub && type === "dict" && v && typeof v === "object" && !Array.isArray(v)) {
    checkObject(sub, v as Record<string, unknown>, label, line, node, out);
  }
}

function nodeItem(node: YNode | undefined, i: number): YNode | undefined {
  return node?.kind === "seq" ? node.items[i] : undefined;
}

function checkObject(
  options: Record<string, DocOption>,
  obj: Record<string, unknown>,
  prefix: string,
  line: number,
  node: YNode | undefined,
  out: CheckOut,
): void {
  const entries = node?.kind === "map" ? node.entries : null;
  const set = new Set<string>();
  for (const [k, v] of Object.entries(obj)) {
    const e = entries?.find((x) => x.key === k);
    const l = e?.keyLine ?? line;
    const found = findOption(options, k);
    if (!found) {
      out.unknown.push(`unknown option ${prefix}.${k} (line ${l})`);
      continue;
    }
    set.add(found[0]);
    checkValue(`${prefix}.${k}`, found[1], v, l, e?.value, out);
  }
  for (const [name, o] of Object.entries(options)) {
    if (o.required && !set.has(name)) {
      out.missing.push(
        `missing required option ${prefix}.${name}${o.aliases?.length ? ` (aliases: ${o.aliases.join(", ")})` : ""}`,
      );
    }
  }
}

const MUTEX =
  /(?:mutually exclusive with|instead of|cannot be used (?:together )?with|conflicts with)\s+O\(([\w.]+)\)/gi;

/** Prose hints of mutual exclusion between options the task sets (ansible-doc has no structured form). */
function proseConflicts(options: Record<string, DocOption>, setNames: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of setNames) {
    const desc = options[a]?.description;
    const text = Array.isArray(desc) ? desc.join(" ") : String(desc ?? "");
    for (const m of text.matchAll(MUTEX)) {
      const b = m[1]!.split("=")[0]!;
      if (b === a || !setNames.includes(b)) continue;
      const pair = [a, b].sort((x, y) => setNames.indexOf(x) - setNames.indexOf(y));
      const key = pair.join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(
        `${pair[0]} and ${pair[1]} are mutually exclusive in the module's argument_spec, which ansible-doc does not expose`,
      );
    }
  }
  return out;
}

export interface TaskCheck {
  task: WalkTask;
  header: string;
  problems: string[];
  okLine?: string;
  hasAction: boolean;
}

export function checkTask(t: WalkTask, docs: DocResult): TaskCheck {
  const loc = `:${t.line}`;
  if (t.conflicting) {
    return {
      task: t,
      header: loc,
      problems: [`conflicting action statements: ${t.conflicting.join(", ")}`],
      hasAction: false,
    };
  }
  const res = resolveTaskDoc(t, docs);
  if (!res) return { task: t, header: loc, problems: ["no module/action detected in task"], hasAction: false };
  if (res.kind === "missing")
    return { task: t, header: `${loc} ${res.asked}`, problems: [res.reason], hasAction: false };
  const doc = res.doc;
  let header = `${loc} ${doc.fqcn}`;
  if (t.action !== doc.fqcn)
    header += t.action!.includes(".") ? ` (redirected from ${t.action})` : ` (from short name ${t.action})`;
  if (t.form === "kv") header += " (key=value form)";

  const out: CheckOut = { unknown: [], values: [], missing: [], deprecated: [], templated: [], aliases: [] };
  const options = doc.options ?? {};
  const short = doc.fqcn.split(".").pop();
  const setNames: string[] = [];
  if (short !== "set_fact") {
    for (const a of t.args) {
      if (a.name === "_raw_params") {
        if (!isFreeForm(doc.fqcn)) out.unknown.push(`free-form text is not accepted by this module (line ${a.line})`);
        continue;
      }
      const found = findOption(options, a.name);
      if (!found) {
        out.unknown.push(`unknown option ${a.name} (line ${a.line})`);
        continue;
      }
      const [canonical, spec, alias] = found;
      setNames.push(canonical);
      if (alias) out.aliases.push(`${alias} is an alias of ${canonical}`);
      if (spec.deprecated) {
        const d = spec.deprecated as Record<string, unknown>;
        out.deprecated.push(
          `${a.name} (line ${a.line}) is deprecated${d.removed_in ? ` (removed in ${d.removed_in})` : ""}${d.why ? `: ${String(d.why)}` : ""}`,
        );
      }
      checkValue(a.name, spec, a.value, a.line, (a as ArgEntry).node, out);
    }
    const hasRaw = t.args.some((a) => a.name === "_raw_params");
    for (const [name, o] of Object.entries(options)) {
      if (!o.required || setNames.includes(name)) continue;
      if (hasRaw && isFreeForm(doc.fqcn)) continue;
      out.missing.push(
        `missing required option ${name}${o.aliases?.length ? ` (aliases: ${o.aliases.join(", ")})` : ""}`,
      );
    }
  }
  const dups = t.duplicates.map((d) => `duplicate key ${d.key} (line ${d.line}); Ansible keeps the last one`);
  const problems = [...out.unknown, ...out.values, ...out.missing, ...out.deprecated, ...dups];
  if (problems.length > 0) {
    if (doc.hasAction) header += " [has action plugin; ansible-lint skips its arguments]";
    return { task: t, header, problems, hasAction: doc.hasAction };
  }
  const prose = proseConflicts(options, setNames);
  let ok = prose.length ? "ok by docs" : "ok";
  if (out.templated.length) {
    ok += `; ${out.templated.length} templated value${out.templated.length === 1 ? "" : "s"} not checked (${out.templated.join(", ")})`;
  }
  if (out.aliases.length) ok += ` (${out.aliases.join("; ")})`;
  if (prose.length) ok += ` [not checked: ${prose.join("; ")}]`;
  return { task: t, header, problems: [], okLine: `${header}: ${ok}`, hasAction: doc.hasAction };
}

export function renderChecks(label: string, core: string, checks: TaskCheck[], scope?: string): string {
  const bad = checks.filter((c) => c.problems.length > 0);
  const nProblems = bad.reduce((n, c) => n + c.problems.length, 0);
  const summary =
    nProblems === 0
      ? "no problems found"
      : `${nProblems} problem${nProblems === 1 ? "" : "s"} in ${bad.length} task${bad.length === 1 ? "" : "s"}`;
  const lines = [
    `${label}: ${checks.length} task${checks.length === 1 ? "" : "s"} checked against installed docs (${core})${scope ? ` ${scope}` : ""}: ${summary}`,
  ];
  let prevFile: string | null = null;
  const multiFile = new Set(checks.map((c) => c.task.file)).size > 1;
  for (const c of checks) {
    if (multiFile && c.task.file !== prevFile) {
      lines.push(`${c.task.file}:`);
      prevFile = c.task.file;
    }
    if (c.problems.length === 0) {
      lines.push(`  ${c.okLine}`);
    } else {
      lines.push(`  ${c.header}`);
      for (const p of c.problems) lines.push(`    ${p}`);
    }
  }
  if (checks.length === 0) lines.push("  (no tasks found)");
  lines.push(NOT_CHECKED_FOOTER);
  return lines.join("\n");
}

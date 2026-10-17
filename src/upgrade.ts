import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  choicesOf,
  collectionRootOf,
  type DocOption,
  findOption,
  type PluginDoc,
  subOptionsOf,
  type Tombstone,
  typeOf,
} from "./ansibleDoc.js";
import { describeValue, docNamesFor, resolveTaskDoc, typeError } from "./checkArgs.js";
import { byCollection, parseCollectionList, parseRequirements } from "./collections.js";
import { setting, settingList } from "./config.js";
import { bumpKind, compareVersions, EXACT_VERSION_RE, satisfies } from "./constraints.js";
import type { AnsibleContext, Project } from "./context.js";
import { PlainAnswer } from "./paths.js";
import { firstSentence, parseStderrMessages, prescanPlaybook } from "./playbook.js";
import { detectProject, ProjectFiles, type WalkTask, walkPlaybooks } from "./project.js";
import { hasSecretShape, isSecretKey, NO_LOG, redactStandalone, redactText } from "./redact.js";
import { isTemplated, parseYaml, toJS } from "./yaml.js";

/**
 * ansible_upgrade_impact (design.md section 6): what breaks in THIS project's
 * tasks if one collection moves to an exact version. The target is installed
 * with `ansible-galaxy collection install --no-deps -p <cache temp dir>` (never
 * into the user's collections paths, never from requirements.yml), then the
 * installed and target arg specs of the modules the project uses are diffed,
 * with meta/runtime.yml routing (redirects, tombstones, deprecations).
 */

export const COLLECTION_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

// --- meta/runtime.yml -----------------------------------------------------------

export interface RoutingEntry {
  redirect?: string;
  deprecation?: { removal_version?: string; removal_date?: string; warning_text?: string };
  tombstone?: { removal_version?: string; removal_date?: string; warning_text?: string };
}

export interface Runtime {
  requiresAnsible?: string;
  routing: Record<string, Record<string, RoutingEntry>>;
}

export function parseRuntime(text: string | null): Runtime {
  if (!text) return { routing: {} };
  const v = toJS(parseYaml(text).root) as Record<string, any> | null;
  const routing: Runtime["routing"] = {};
  for (const [type, entries] of Object.entries((v?.plugin_routing ?? {}) as Record<string, any>)) {
    if (entries && typeof entries === "object") routing[type] = entries as Record<string, RoutingEntry>;
  }
  const req = v?.requires_ansible;
  return { ...(req !== undefined && req !== null ? { requiresAnsible: String(req) } : {}), routing };
}

/** Routing for a plugin, matched by its short name and by its full name (design.md 6.4). */
export function routingFor(rt: Runtime, type: string, fqcn: string, collection: string): RoutingEntry | undefined {
  const t = rt.routing[type === "module" ? "modules" : type];
  if (!t) return undefined;
  const short = fqcn.startsWith(`${collection}.`) ? fqcn.slice(collection.length + 1) : fqcn;
  return t[short] ?? t[fqcn];
}

// --- Findings -------------------------------------------------------------------

export type Severity = "BLOCKED" | "BREAKING" | "WARNING" | "BEHAVIOR CHANGE" | "DEPRECATION" | "INFO";

export interface Finding {
  severity: Severity;
  file: string;
  line: number;
  subject: string;
  text: string;
  /** Sort order within a task. */
  order: number;
}

export interface UsedModule {
  task: WalkTask;
  fqcn: string;
  installedDoc: PluginDoc;
}

export interface ModuleDiffInput {
  used: UsedModule;
  collection: string;
  /** Target doc when the module resolved INTO the target tree, else undefined. */
  targetDoc?: PluginDoc;
  targetTombstone?: Tombstone;
  targetRouting?: RoutingEntry;
  installedRouting?: RoutingEntry;
  /** For a redirect: the new name resolved (with its collection version), or null when it does not resolve. */
  redirectResolved?: { fqcn: string; version?: string } | null;
}

/**
 * A documented default in a BEHAVIOR CHANGE line, redacted like
 * ansible_module_doc / ansible_role_interface print defaults (design.md 5):
 * `(no_log)` when either side's spec is `no_log`, else layers 1, 3 and 4 under
 * the option name. A plain string keeps its single-quoted form.
 */
function fmtDefault(v: unknown, name: string, noLog: boolean): string {
  if (noLog) return NO_LOG;
  const r = redactStandalone(v ?? null, name);
  if (r.startsWith('"')) {
    try {
      const s: unknown = JSON.parse(r);
      if (typeof s === "string") return `'${s}'`;
    } catch {
      // not a bare JSON string: print as rendered
    }
  }
  return r;
}
const fmtChoiceValue = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * Whether an option value must not be echoed (design.md 5, same rule as
 * ansible_check_task_args): `no_log`, a secret-like option name, or a
 * secret-shaped value. Without this the "no longer accepted" / "does not
 * convert" messages would print the task's literal value.
 */
function sensitive(label: string, spec: DocOption, v: unknown): boolean {
  return spec.no_log === true || isSecretKey(label) || (typeof v === "string" && hasSecretShape(v));
}

function isSet(args: { name: string }[], options: Record<string, DocOption>, name: string, also?: DocOption): boolean {
  const aliases = new Set([name, ...(options[name]?.aliases ?? []), ...(also?.aliases ?? [])]);
  return args.some((a) => aliases.has(a.name));
}

function diffOptions(
  inst: Record<string, DocOption>,
  targ: Record<string, DocOption>,
  args: { name: string; line: number; value: unknown }[],
  prefix: string,
  push: (sev: Severity, text: string, order: number) => void,
): void {
  for (const a of args) {
    if (a.name === "_raw_params") continue;
    const fi = findOption(inst, a.name);
    if (!fi) continue; // already unknown today: not an upgrade finding
    const [canon, specI] = fi;
    const label = `${prefix}${a.name}`;
    const ft = findOption(targ, a.name);
    if (!ft) {
      if (Object.hasOwn(targ, canon))
        push("BREAKING", `alias ${label} dropped; use ${prefix}${canon} (line ${a.line})`, 2);
      else push("BREAKING", `option ${label} removed (line ${a.line})`, 1);
      continue;
    }
    const specT = ft[1];
    const v = a.value;
    const show = sensitive(label, specI, v) || sensitive(label, specT, v) ? "a value" : fmtChoiceValue(v);
    const chT = choicesOf(specT);
    const chI = choicesOf(specI);
    if (chT && v !== null && v !== undefined && typeof v !== "object" && !isTemplated(v)) {
      const inT = chT.some((c) => c === v || String(c) === String(v));
      const inI = !chI || chI.some((c) => c === v || String(c) === String(v));
      if (!inT && inI) {
        push(
          "BREAKING",
          `${label}=${show} no longer accepted (choices: ${chT.map(String).join(", ")}) (line ${a.line})`,
          4,
        );
      }
    }
    const tI = typeOf(specI);
    const tT = typeOf(specT);
    if (tI !== tT && v !== null && v !== undefined) {
      const showT = sensitive(label, specI, v) || sensitive(label, specT, v) ? "a value" : describeValue(v);
      if (isTemplated(v)) {
        push("WARNING", `${label} type ${tI} -> ${tT}; cannot evaluate a templated value (line ${a.line})`, 5);
      } else if (typeError(tT, v) === null) {
        push("INFO", `${label} type ${tI} -> ${tT}; value ${showT} still converts (line ${a.line})`, 5);
      } else {
        push("BREAKING", `${label} type ${tI} -> ${tT}; value ${showT} does not convert (line ${a.line})`, 5);
      }
    }
    if (specT.deprecated && !specI.deprecated) {
      const d = specT.deprecated as Record<string, unknown>;
      push(
        "DEPRECATION",
        `${label} is deprecated${d.removed_in ? ` (removed in ${d.removed_in})` : ""}${d.why ? `: ${String(d.why)}` : ""} (line ${a.line})`,
        6,
      );
    }
    const subI = subOptionsOf(specI);
    const subT = subOptionsOf(specT);
    if (subI && subT) {
      const objs = Array.isArray(v) ? v : [v];
      for (const o of objs) {
        if (!o || typeof o !== "object" || Array.isArray(o)) continue;
        const subArgs = Object.entries(o as Record<string, unknown>).map(([name, value]) => ({
          name,
          value,
          line: a.line,
        }));
        diffOptions(subI, subT, subArgs, `${label}.`, push);
      }
    }
  }
  for (const [name, specT] of Object.entries(targ)) {
    const specI = inst[name];
    const set = isSet(args, targ, name, specI);
    if (specT.required && !specI?.required && !set) push("BREAKING", `${prefix}${name} is newly required, not set`, 3);
    if (!set && specI && !specT.required) {
      const dI = specI.default ?? null;
      const dT = specT.default ?? null;
      if (JSON.stringify(dI) !== JSON.stringify(dT)) {
        const noLog = specI.no_log === true || specT.no_log === true;
        push(
          "BEHAVIOR CHANGE",
          `${prefix}${name} not set; default ${fmtDefault(dI, name, noLog)} -> ${fmtDefault(dT, name, noLog)}`,
          7,
        );
      }
    }
  }
}

/** All findings for one task that uses a module of the collection. */
export function diffModuleUsage(x: ModuleDiffInput): Finding[] {
  const out: Finding[] = [];
  const t = x.used.task;
  const push = (severity: Severity, text: string, order: number) =>
    out.push({ severity, file: t.file, line: t.line, subject: x.used.fqcn, text, order });
  const tomb = x.targetRouting?.tombstone;
  if (tomb || x.targetTombstone) {
    const v = tomb?.removal_version ?? x.targetTombstone?.version ?? tomb?.removal_date ?? "?";
    const why = tomb?.warning_text ?? x.targetTombstone?.text ?? "";
    push("BREAKING", `removed in ${v} (tombstone)${why ? `: ${why}` : ""}`, 0);
    return out;
  }
  const redirect = x.targetRouting?.redirect;
  if (redirect) {
    const coll = redirect.split(".").slice(0, 2).join(".");
    if (x.redirectResolved) {
      push(
        "WARNING",
        `moved to ${redirect}${x.redirectResolved.version ? ` (installed ${x.redirectResolved.version})` : ""}; update the task to the new name`,
        0,
      );
    } else {
      push("BREAKING", `moved to ${redirect}; ${coll} is not installed (add it to requirements.yml)`, 0);
      return out;
    }
  }
  if (!x.targetDoc) {
    if (!redirect) push("BREAKING", "removed (not in the target version, and no routing explains it)", 0);
    return out;
  }
  const depT = x.targetDoc.deprecated ?? x.targetRouting?.deprecation;
  const depI = x.used.installedDoc.deprecated ?? x.installedRouting?.deprecation;
  if (depT && !depI) {
    const d = depT as Record<string, string | undefined>;
    const v = d.removed_in ?? d.removal_version ?? d.removal_date;
    const why = d.why ?? d.warning_text ?? "";
    const alt = d.alternative ? `; ${d.alternative}` : "";
    push("DEPRECATION", `deprecated${v ? `, removed in ${v}` : ""}${why ? `: ${why}` : ""}${alt}`, 0);
  }
  if (!redirect) diffOptions(x.used.installedDoc.options ?? {}, x.targetDoc.options ?? {}, t.args, "", push);
  return out;
}

// --- Report ---------------------------------------------------------------------

export interface UpgradeReport {
  collection: string;
  installedVersion: string;
  targetVersion: string;
  dirLabel: string;
  core: string;
  requiresAnsible?: string;
  /** undefined with requiresAnsible set: not evaluated, see requiresError. */
  requiresOk?: boolean;
  /** Why requires_ansible could not be evaluated (e.g. `~=` is not parsed). */
  requiresError?: string;
  dependencies: string[];
  cacheNote: string;
  constraints: string[];
  used: UsedModule[];
  playbookFiles: Set<string>;
  findings: Finding[];
  notFollowed: string[];
  syntax: string[];
  unused: string[];
  warnings: string[];
}

const SECTIONS: { sev: Severity; title: string }[] = [
  { sev: "BLOCKED", title: "BLOCKED" },
  { sev: "BREAKING", title: "BREAKING" },
  { sev: "WARNING", title: "WARNINGS" },
  { sev: "BEHAVIOR CHANGE", title: "BEHAVIOR CHANGES" },
  { sev: "DEPRECATION", title: "DEPRECATIONS" },
  { sev: "INFO", title: "INFO" },
];

export function renderUpgrade(r: UpgradeReport): string {
  const lines: string[] = [];
  const down = compareVersions(r.targetVersion, r.installedVersion) < 0 ? ", downgrade" : "";
  lines.push(
    `upgrade ${r.collection} ${r.installedVersion} -> ${r.targetVersion} (${bumpKind(r.installedVersion, r.targetVersion)}${down}) for ${r.dirLabel}`,
  );
  const req = !r.requiresAnsible
    ? "requires_ansible not declared"
    : r.requiresOk === undefined
      ? `requires_ansible '${r.requiresAnsible}' could not evaluate (${r.requiresError ?? "unparseable"}; ansible-core ${r.core})`
      : `requires_ansible '${r.requiresAnsible}' ${r.requiresOk ? "ok" : "NOT satisfied"} (ansible-core ${r.core})`;
  lines.push(
    `target: ${req}; dependencies: ${r.dependencies.length ? r.dependencies.join(", ") : "none"}; ${r.cacheNote}`,
  );
  for (const w of r.warnings) lines.push(`WARNING: ${w}`);
  lines.push(`constraints: ${r.constraints.length ? r.constraints.join("; ") : "none in requirements files"}`);

  // Used modules grouped by file: playbooks first, then files in walk order.
  const byFile = new Map<string, string[]>();
  const viaShort = new Map<string, Set<string>>();
  for (const u of r.used) {
    const short = u.fqcn.slice(r.collection.length + 1);
    const list = byFile.get(u.task.file) ?? [];
    if (!list.includes(short)) list.push(short);
    byFile.set(u.task.file, list);
    if (u.task.action && !u.task.action.includes(".")) {
      const s = viaShort.get(u.task.file) ?? new Set();
      s.add(u.task.action);
      viaShort.set(u.task.file, s);
    }
  }
  const files = [...byFile.keys()].sort((a, b) => Number(!r.playbookFiles.has(a)) - Number(!r.playbookFiles.has(b)));
  const nUsed = new Set(r.used.map((u) => u.fqcn)).size;
  const groups = files.map((f) => {
    const s = viaShort.get(f);
    return `${byFile.get(f)!.join(", ")} (${f}${s ? `, via short name ${[...s].join(", ")}` : ""})`;
  });
  lines.push(`used modules (${nUsed}): ${groups.join("; ") || "(none)"}`);
  if (r.notFollowed.length) {
    lines.push(
      `not followed (${r.notFollowed.length}): ${r.notFollowed.slice(0, 10).join("; ")}${r.notFollowed.length > 10 ? "; ..." : ""}`,
    );
  }
  const fileRank = (f: string) => files.indexOf(f);
  const sorted = [...r.findings].sort(
    (a, b) => fileRank(a.file) - fileRank(b.file) || a.line - b.line || a.order - b.order || (a.text < b.text ? -1 : 1),
  );
  const counts: Partial<Record<Severity, number>> = {};
  for (const s of SECTIONS) {
    const list = sorted.filter((f) => f.severity === s.sev);
    counts[s.sev] = list.length;
    if (!list.length) continue;
    lines.push(`${s.title} (${list.length}):`);
    for (const f of list) lines.push(f.file ? `  ${f.file}:${f.line} ${f.subject}: ${f.text}` : `  ${f.text}`);
  }
  for (const s of r.syntax) lines.push(s);
  if (r.unused.length) {
    lines.push(`unused content changes (${r.unused.length}):`);
    for (const u of r.unused) lines.push(`  ${u}`);
  }
  let verdict: string;
  if (counts.BREAKING) verdict = `BREAKING (${counts.BREAKING})`;
  else if (counts["BEHAVIOR CHANGE"]) verdict = `BEHAVIOR CHANGES (${counts["BEHAVIOR CHANGE"]})`;
  else if (counts.WARNING) verdict = `WARNINGS (${counts.WARNING})`;
  else if (counts.DEPRECATION) verdict = "DEPRECATIONS ONLY";
  else verdict = "NO IMPACT on used modules";
  if (r.requiresAnsible && r.requiresOk === false) {
    verdict = `BLOCKED (requires_ansible '${r.requiresAnsible}' excludes ansible-core ${r.core})${verdict.startsWith("BREAKING") ? `; also ${verdict}` : ""}`;
  } else if (r.requiresAnsible && r.requiresOk === undefined) {
    verdict += "; requires_ansible not checked";
  }
  lines.push(`verdict: ${verdict}`);
  return lines.join("\n");
}

/** requirements.yml constraint lines for the collection (design.md 6.5, last rule). */
export function constraintLines(
  reqFiles: { file: string; text: string }[],
  collection: string,
  installed: string,
  target: string,
): string[] {
  const out: string[] = [];
  for (const { file, text } of reqFiles) {
    const reqs = parseRequirements(parseYaml(text).root, file);
    for (const q of reqs.collections) {
      if (q.name !== collection) continue;
      if (!q.version || q.version === "*") {
        out.push(`${file}:${q.line} has no version constraint`);
        continue;
      }
      let tOk = false;
      let iOk = false;
      try {
        tOk = satisfies(target, q.version);
        iOk = satisfies(installed, q.version);
      } catch {
        out.push(`${file}:${q.line} pins '${q.version}' (not parseable)`);
        continue;
      }
      if (!tOk) out.push(`${file}:${q.line} pins '${q.version}' (change it to allow ${target})`);
      else if (!iOk)
        out.push(
          `${file}:${q.line} pins '${q.version}' (satisfied by the target; installed ${installed} violates it today)`,
        );
      else out.push(`${file}:${q.line} pins '${q.version}' (satisfied by the target)`);
    }
  }
  return out;
}

// --- Target download and cache ----------------------------------------------------

export function mapGalaxyError(
  stderr: string,
  code: number | null,
  collection: string,
  version: string,
  dir: string,
  cached: string[],
): string {
  if (/Could not satisfy the following requirements/.test(stderr)) {
    return `${collection} ${version} was not found on the configured Galaxy servers (the version or the collection does not exist, or the server needs credentials). Nothing in ${dir} was changed.`;
  }
  const m = /Unknown error when attempting to call Galaxy at '([^']+)'/.exec(stderr);
  if (m) {
    let host = m[1]!;
    try {
      host = new URL(m[1]!).host;
    } catch {
      // keep the raw text
    }
    return `could not reach ${host} to download ${collection} ${version} (offline or proxy). Cached targets: ${cached.length ? cached.join(", ") : "none"}. Nothing in ${dir} was changed.`;
  }
  return `ansible-galaxy collection install failed (exit ${code}):\n${redactText(stderr.trim()).slice(0, 2048)}`;
}

interface TargetTree {
  /** Ansible-side collections path holding `ansible_collections/<ns>/<name>`. */
  dir: string;
  downloaded: boolean;
  manifest: Record<string, any>;
}

async function readManifest(
  ctx: AnsibleContext,
  treeDir: string,
  collection: string,
): Promise<Record<string, any> | null> {
  const [ns, name] = collection.split(".");
  const text = await ctx.runner.sideReadFile(
    ctx.runner.sideJoin(treeDir, "ansible_collections", ns!, name!, "MANIFEST.json"),
  );
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function listCached(ctx: AnsibleContext, base: string): Promise<string[]> {
  if (!ctx.runner.prefixed) {
    try {
      return readdirSync(base).filter((d) => !d.startsWith("."));
    } catch {
      return [];
    }
  }
  const r = await ctx.runner.raw("ls", ["-1", "--", base], {});
  return r.code === 0 ? r.stdout.split("\n").filter((d) => d && !d.startsWith(".")) : [];
}

/**
 * `ansible-galaxy collection install` creates `~/.ansible/galaxy_token` when it
 * does not exist. When the user has no token file (and did not configure
 * GALAXY_TOKEN_PATH), point it at the server's cache so ~/.ansible stays
 * untouched; an existing token file is left in use (it may carry credentials).
 */
async function galaxyTokenEnv(ctx: AnsibleContext, p: Project): Promise<Record<string, string>> {
  const s = setting(await ctx.config(p), "GALAXY_TOKEN_PATH");
  if (s && s.origin !== "default") return {};
  const home = (await ctx.runner.sideEnv()).HOME ?? "";
  const path = String(s?.value ?? "~/.ansible/galaxy_token").replace(/^~(?=\/|$)/, home);
  if ((await ctx.runner.sideReadFile(path)) !== null) return {};
  return { ANSIBLE_GALAXY_TOKEN_PATH: ctx.runner.sideJoin(await ctx.runner.sideCacheRoot(), "galaxy_token") };
}

export async function ensureTarget(
  ctx: AnsibleContext,
  p: Project,
  collection: string,
  version: string,
): Promise<TargetTree> {
  const root = ctx.runner.sideJoin(await ctx.runner.sideCacheRoot(), "collections");
  const base = ctx.runner.sideJoin(root, collection);
  const target = ctx.runner.sideJoin(base, version);
  const hit = await readManifest(ctx, target, collection);
  if (hit && hit.collection_info?.version === version) return { dir: target, downloaded: false, manifest: hit };

  await ctx.runner.sideMkdirp(base);
  const tmp = ctx.runner.sideJoin(base, `.tmp-${version}-${randomBytes(4).toString("hex")}`);
  let stale: string | undefined;
  try {
    const r = await ctx.runSafe(
      p,
      "ansible-galaxy",
      ["collection", "install", "--no-deps", "-p", tmp, `${collection}:==${version}`],
      {
        timeoutMs: ctx.runner.cfg.timeoutMs * 3,
        env: await galaxyTokenEnv(ctx, p),
      },
    );
    if (r.code !== 0) {
      throw new PlainAnswer(mapGalaxyError(r.stderr, r.code, collection, version, p.dir, await listCached(ctx, base)));
    }
    const m = await readManifest(ctx, tmp, collection);
    if (!m || m.collection_info?.version !== version) {
      throw new Error(`ansible-galaxy installed ${collection} but MANIFEST.json does not say ${version}.`);
    }
    if (await ctx.runner.sideRename(tmp, target)) return { dir: target, downloaded: true, manifest: m };
    // Target exists: another process won the race, or a stale tree (no
    // MANIFEST.json, or one naming another version) sits there and would make
    // every call re-download. Keep a correct winner; move anything else aside
    // as a `.tmp-stale-*` sibling, removed in the `finally` below. Only if that
    // removal itself fails does the sibling stay: the startup sweep clears it
    // from the native cache after an hour, but nothing sweeps the Ansible-side
    // cache in prefix mode (ANSIBLE_MCP_REMOTE_CACHE), where it stays until
    // removed by hand. If the move aside fails, the target is left untouched.
    const winner = await readManifest(ctx, target, collection);
    if (winner?.collection_info?.version === version) return { dir: target, downloaded: true, manifest: winner };
    const aside = ctx.runner.sideJoin(base, `.tmp-stale-${randomBytes(4).toString("hex")}`);
    if (await ctx.runner.sideRename(target, aside)) stale = aside;
    if (!stale || !(await ctx.runner.sideRename(tmp, target))) {
      throw new Error(
        `could not move the downloaded ${collection} ${version} into the cache at ${target} (it holds ${winner ? `a tree that says ${winner.collection_info?.version ?? "no version"}` : "no MANIFEST.json"}); remove that directory and retry.`,
      );
    }
    return { dir: target, downloaded: true, manifest: m };
  } finally {
    await ctx.runner.sideRemoveTemp(tmp, root).catch(() => {});
    if (stale) await ctx.runner.sideRemoveTemp(stale, root).catch(() => {});
  }
}

/** Remove `.tmp-*` dirs older than 1 h under the native cache (crashed downloads). */
export function sweepStaleTempDirs(cacheDir: string, now = Date.now()): void {
  const root = join(cacheDir, "collections");
  let colls: string[];
  try {
    colls = readdirSync(root);
  } catch {
    return;
  }
  for (const c of colls) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, c));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.startsWith(".tmp-")) continue;
      const p = join(root, c, e);
      try {
        if (now - statSync(p).mtimeMs > 3_600_000) rmSync(p, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
}

// --- Orchestration ------------------------------------------------------------------

export interface UpgradeParams {
  collection: string;
  version: string;
  dir?: string;
  playbooks?: string[];
  syntaxCheck: boolean;
  includeUnused: boolean;
}

export async function upgradeImpact(ctx: AnsibleContext, params: UpgradeParams): Promise<string> {
  const prev = ctx.upgradeLock;
  let release: () => void = () => {};
  ctx.upgradeLock = new Promise<void>((r) => {
    release = r;
  });
  await prev.catch(() => {});
  try {
    return await runUpgrade(ctx, params);
  } finally {
    release();
  }
}

async function runUpgrade(ctx: AnsibleContext, x: UpgradeParams): Promise<string> {
  const collection = x.collection.trim();
  const version = x.version.trim();
  if (!COLLECTION_RE.test(collection)) return "collection must be namespace.name, e.g. community.general";
  if (!EXACT_VERSION_RE.test(version)) return "version must be an exact version like 12.0.0, not a constraint";
  ctx.runner.assertAvailable();
  const p = await ctx.project(x.dir);
  const [ver, cfg] = await Promise.all([ctx.version(), ctx.config(p)]);
  const collectionsPaths = settingList(cfg, "COLLECTIONS_PATHS");
  const listRes = await ctx.runSafe(p, "ansible-galaxy", ["collection", "list", "--format", "json"]);
  if (listRes.code !== 0)
    throw new Error(
      `ansible-galaxy collection list failed (exit ${listRes.code}):\n${redactText(listRes.stderr.trim()).slice(0, 2048)}`,
    );
  const installedAll = byCollection(parseCollectionList(listRes.stdout), collectionsPaths);
  const eff = installedAll.get(collection)?.[0];
  if (!eff) {
    return `${collection} is not installed in any collections path (${collectionsPaths.map((c) => ctx.runner.displaySide(c)).join(", ") || "none"}); nothing to compare. ansible_collections shows what requirements.yml expects.`;
  }
  if (eff.version === version)
    return `${collection} is already installed at ${version} (${ctx.runner.displaySide(eff.path)}); nothing to compare.`;

  // Usage (static walk) and installed docs.
  const files = new ProjectFiles(p.dir);
  const det = detectProject(
    p.dir,
    settingList(cfg, "DEFAULT_HOST_LIST").map((s) => ctx.rel(p, s)),
  );
  const playbooks = x.playbooks?.length ? x.playbooks : det.playbooks.map((pb) => pb.rel);
  for (const pb of playbooks) {
    if (pb.trim().startsWith("-")) throw new PlainAnswer("playbooks must not start with '-'");
    ctx.runner.assertLocal(pb);
  }
  const rolesPaths = settingList(cfg, "DEFAULT_ROLES_PATH")
    .map((s) => ctx.runner.serverPathOf(s))
    .filter((s): s is string => !!s);
  const walk = walkPlaybooks(files, playbooks, { rolesPaths });
  const installedDocs = await ctx.docs(p, docNamesFor(walk.tasks));
  const used: UsedModule[] = [];
  for (const t of walk.tasks) {
    const res = resolveTaskDoc(t, installedDocs);
    if (res?.kind === "doc" && res.doc.fqcn.startsWith(`${collection}.`)) {
      used.push({ task: t, fqcn: res.doc.fqcn, installedDoc: res.doc });
    }
  }

  // Target tree (download on a cache miss).
  const tree = await ensureTarget(ctx, p, collection, version);
  const targetPath = [tree.dir, ...collectionsPaths].join(":");
  const fqcns = [...new Set(used.map((u) => u.fqcn))];
  const targetDocs = fqcns.length ? await ctx.docs(p, fqcns, { collectionsPath: targetPath }) : null;
  const [ns, name] = collection.split(".");
  const targetRuntime = parseRuntime(
    await ctx.runner.sideReadFile(
      ctx.runner.sideJoin(tree.dir, "ansible_collections", ns!, name!, "meta", "runtime.yml"),
    ),
  );
  const instRoot = used[0] ? collectionRootOf(used[0].installedDoc.filename) : null;
  const installedRuntime = parseRuntime(
    instRoot ? await ctx.runner.sideReadFile(`${instRoot}/meta/runtime.yml`) : null,
  );

  const findings: Finding[] = [];
  const redirectCache = new Map<string, { fqcn: string; version?: string } | null>();
  for (const u of used) {
    const routing = routingFor(targetRuntime, "module", u.fqcn, collection);
    let targetDoc = targetDocs?.docs.get(u.fqcn);
    if (targetDoc && !slash(targetDoc.filename).startsWith(`${slash(tree.dir)}/`)) targetDoc = undefined;
    let redirectResolved: { fqcn: string; version?: string } | null | undefined;
    if (routing?.redirect) {
      if (!redirectCache.has(routing.redirect)) {
        const rd = await ctx.docs(p, [routing.redirect], { collectionsPath: targetPath });
        const d = rd.docs.get(routing.redirect);
        redirectCache.set(
          routing.redirect,
          d ? { fqcn: d.fqcn, version: installedAll.get(d.collection)?.[0]?.version } : null,
        );
      }
      redirectResolved = redirectCache.get(routing.redirect);
    }
    findings.push(
      ...diffModuleUsage({
        used: u,
        collection,
        targetDoc,
        targetTombstone: targetDocs?.tombstones.find((t) => t.name === u.fqcn),
        targetRouting: routing,
        installedRouting: routingFor(installedRuntime, "module", u.fqcn, collection),
        redirectResolved,
      }),
    );
  }
  // Fully-qualified lookup / filter / test references in strings: routing checks only.
  for (const t of walk.tasks) {
    for (const ref of t.pluginRefs) {
      if (!ref.name.startsWith(`${collection}.`)) continue;
      const rt = routingFor(targetRuntime, ref.kind, ref.name, collection);
      if (rt?.tombstone) {
        findings.push({
          severity: "BREAKING",
          file: t.file,
          line: ref.line,
          subject: `${ref.name} (${ref.kind})`,
          text: `removed in ${rt.tombstone.removal_version ?? rt.tombstone.removal_date ?? "?"} (tombstone)${rt.tombstone.warning_text ? `: ${rt.tombstone.warning_text}` : ""}`,
          order: 0,
        });
      } else if (rt?.redirect) {
        findings.push({
          severity: "WARNING",
          file: t.file,
          line: ref.line,
          subject: `${ref.name} (${ref.kind})`,
          text: `moved to ${rt.redirect}; check that its collection is installed`,
          order: 0,
        });
      } else if (rt?.deprecation && !routingFor(installedRuntime, ref.kind, ref.name, collection)?.deprecation) {
        findings.push({
          severity: "DEPRECATION",
          file: t.file,
          line: ref.line,
          subject: `${ref.name} (${ref.kind})`,
          text: `deprecated${rt.deprecation.removal_version ? `, removed in ${rt.deprecation.removal_version}` : ""}${rt.deprecation.warning_text ? `: ${rt.deprecation.warning_text}` : ""}`,
          order: 0,
        });
      }
    }
  }

  // Dependencies and requires_ansible.
  const warnings: string[] = [];
  const deps = Object.entries((tree.manifest.collection_info?.dependencies ?? {}) as Record<string, string>).map(
    ([d, spec]) => {
      const have = installedAll.get(d)?.[0]?.version;
      let ok = false;
      try {
        ok = !!have && satisfies(have, spec);
      } catch {
        ok = false;
      }
      if (!ok)
        warnings.push(`${version} depends on ${d} ${spec} (installed: ${have ?? "none"}); docs that need it may fail`);
      return `${d} ${spec}${ok ? "" : ` (installed: ${have ?? "none"})`}`;
    },
  );
  let requiresOk: boolean | undefined;
  let requiresError: string | undefined;
  if (targetRuntime.requiresAnsible) {
    try {
      requiresOk = satisfies(ver.core.replace(/[^\d.].*$/, ""), targetRuntime.requiresAnsible);
    } catch (e) {
      requiresOk = undefined;
      requiresError = e instanceof Error ? e.message : String(e);
    }
  }

  // requirements.yml constraints.
  const reqFiles = det.requirements.map((f) => {
    let text = "";
    try {
      text = readFileSync(join(p.dir, f), "utf8");
    } catch {
      text = "";
    }
    return { file: f, text };
  });
  const constraints = constraintLines(reqFiles, collection, eff.version, version);

  // Optional confirmation: syntax-check with the target first on the path (F14).
  const syntax: string[] = [];
  if (x.syntaxCheck && playbooks.length) {
    for (const pb of playbooks.slice(0, 5)) {
      const hits = prescanPlaybook(files, pb);
      if (hits.length && !ctx.allowPlayLookups) {
        syntax.push(
          `syntax-check with ${version} (${pb}): skipped, the lookup pre-scan refused it (see ansible_playbook_structure)`,
        );
        continue;
      }
      const r = await ctx.runSafe(p, "ansible-playbook", ["--syntax-check", pb], {
        env: { ANSIBLE_COLLECTIONS_PATH: targetPath },
      });
      if (r.code === 0) {
        syntax.push(`syntax-check with ${version}${playbooks.length > 1 ? ` (${pb})` : ""}: ok`);
        continue;
      }
      const err = parseStderrMessages(r.stderr).find((m) => m.kind === "ERROR");
      const where = err?.origin ? `${ctx.rel(p, err.origin.file)}:${err.origin.line}: ` : "";
      const base = await ctx.runSafe(p, "ansible-playbook", ["--syntax-check", pb]);
      const pre = base.code !== 0 ? " [also fails with the installed set]" : "";
      syntax.push(
        `syntax-check with ${version} (${pb}): first error ${where}${redactText(firstSentence(err?.text ?? r.stderr.trim().split("\n")[0] ?? ""))}${pre} (syntax-check stops at the first error and does not check options)`,
      );
    }
  }

  const unused = x.includeUnused
    ? await unusedChanges(ctx, p, collection, tree.dir, collectionsPaths, new Set(fqcns), targetRuntime)
    : [];
  const cacheNote = `${tree.downloaded ? "downloaded" : "cached"} (cache: ${ctx.runner.displaySide(tree.dir)})`;
  return renderUpgrade({
    collection,
    installedVersion: eff.version,
    targetVersion: version,
    dirLabel: p.dir,
    core: ver.core,
    ...(targetRuntime.requiresAnsible
      ? { requiresAnsible: targetRuntime.requiresAnsible, requiresOk, ...(requiresError ? { requiresError } : {}) }
      : {}),
    dependencies: deps,
    cacheNote,
    constraints,
    used,
    playbookFiles: new Set(playbooks),
    findings,
    notFollowed: walk.notFollowed,
    syntax,
    unused,
    warnings,
  });
}

const UNUSED_CAP = 200;

async function unusedChanges(
  ctx: AnsibleContext,
  p: Project,
  collection: string,
  treeDir: string,
  collectionsPaths: string[],
  used: Set<string>,
  targetRuntime: Runtime,
): Promise<string[]> {
  const dump = async (path?: string) => {
    const r = await ctx.runSafe(p, "ansible-doc", ["--metadata-dump", "--no-fail-on-errors", collection], {
      ...(path ? { env: { ANSIBLE_COLLECTIONS_PATH: path } } : {}),
    });
    if (r.code !== 0) return null;
    try {
      return (JSON.parse(r.stdout)?.all ?? {}) as Record<
        string,
        Record<string, { doc?: { filename?: string; deprecated?: any } }>
      >;
    } catch {
      return null;
    }
  };
  const [a, b] = await Promise.all([dump(), dump([treeDir, ...collectionsPaths].join(":"))]);
  if (!a || !b) return ["(metadata dump failed; unused changes not computed)"];
  const out: string[] = [];
  for (const [type, plugins] of Object.entries(a)) {
    if (type === "keyword") continue;
    for (const name of Object.keys(plugins ?? {})) {
      if (used.has(name) || !name.startsWith(`${collection}.`)) continue;
      const rt = routingFor(targetRuntime, type, name, collection);
      const inTarget = slash(b[type]?.[name]?.doc?.filename ?? "").startsWith(`${slash(treeDir)}/`);
      if (rt?.tombstone) out.push(`${type} ${name}: removed (tombstone ${rt.tombstone.removal_version ?? ""})`.trim());
      else if (rt?.redirect) out.push(`${type} ${name}: moved to ${rt.redirect}`);
      else if (!inTarget) out.push(`${type} ${name}: removed`);
      else if (b[type]?.[name]?.doc?.deprecated && !plugins[name]?.doc?.deprecated)
        out.push(`${type} ${name}: deprecated`);
      if (out.length >= UNUSED_CAP) return [...out, "... (capped at 200)"];
    }
  }
  return out;
}

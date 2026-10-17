import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, posix } from "node:path";
import { get, isTemplated, parseYaml, scalarString, toJS, type YamlDoc, type YMap, type YNode } from "./yaml.js";

/**
 * Static reading of an Ansible project with the server's own YAML 1.1 reader:
 * project detection (design.md 7.1) and the task walk used by
 * ansible_check_task_args, ansible_playbook_structure and
 * ansible_upgrade_impact (6.2). Reads files only; never runs anything.
 */

/**
 * Task keywords of ansible-core 2.21 (`ansible-doc -t keyword`, applies_to Task
 * or Handler, plus the Block keywords). A key that is not one of these is the
 * task's action. The unit tests compare this list with doc/keywords.json.
 */
export const TASK_KEYWORDS = new Set([
  "action",
  "any_errors_fatal",
  "args",
  "async",
  "become",
  "become_exe",
  "become_flags",
  "become_method",
  "become_user",
  "changed_when",
  "check_mode",
  "collections",
  "connection",
  "debugger",
  "delay",
  "delegate_facts",
  "delegate_to",
  "diff",
  "environment",
  "failed_when",
  "ignore_errors",
  "ignore_unreachable",
  "loop",
  "loop_control",
  "module_defaults",
  "name",
  "no_log",
  "notify",
  "poll",
  "port",
  "register",
  "remote_user",
  "retries",
  "run_once",
  "tags",
  "throttle",
  "timeout",
  "until",
  "vars",
  "when",
  // Handler / Block keywords and the action shorthand.
  "listen",
  "block",
  "rescue",
  "always",
  "local_action",
]);

export function isTaskKeyword(k: string): boolean {
  return TASK_KEYWORDS.has(k) || k.startsWith("with_");
}

/** Modules whose free-form text becomes `_raw_params` (Ansible's FREEFORM_ACTIONS and friends). */
const FREE_FORM = new Set([
  "command",
  "shell",
  "raw",
  "script",
  "win_command",
  "win_shell",
  "include_vars",
  "add_host",
  "group_by",
  "set_fact",
  "meta",
  "import_tasks",
  "include_tasks",
  "import_playbook",
  "include",
  "debug",
]);

export const shortName = (action: string): string => action.split(".").pop() ?? action;

export function isFreeForm(fqcnOrName: string): boolean {
  const parts = fqcnOrName.split(".");
  if (parts.length === 3 && !(parts[0] === "ansible" && (parts[1] === "builtin" || parts[1] === "legacy"))) {
    return /^win_(command|shell)$/.test(parts[2]!) && parts[0] === "ansible" && parts[1] === "windows";
  }
  return FREE_FORM.has(parts[parts.length - 1]!);
}

/**
 * Ansible's FREEFORM_ACTIONS (constants.MODULE_REQUIRE_ARGS): the modules whose
 * k=v text parse_kv reads with check_raw, so only CHECK_RAW_OPTIONS become
 * options and every other token stays in `_raw_params` (`command: env FOO=bar make`).
 */
const CHECK_RAW_MODULES = new Set(["command", "raw", "script", "shell", "win_command", "win_shell"]);
const CHECK_RAW_OPTIONS = new Set([
  "creates",
  "removes",
  "chdir",
  "executable",
  "warn",
  "stdin",
  "stdin_add_newline",
  "strip_empty_ends",
]);

export function isCheckRawAction(action: string): boolean {
  const parts = action.split(".");
  if (parts.length === 1) return CHECK_RAW_MODULES.has(action);
  if (parts.length !== 3) return false;
  if (parts[0] === "ansible" && (parts[1] === "builtin" || parts[1] === "legacy"))
    return CHECK_RAW_MODULES.has(parts[2]!);
  return parts[0] === "ansible" && parts[1] === "windows" && /^win_(command|shell)$/.test(parts[2]!);
}

/** Play keys that import a playbook (ansible-core's _ACTION_IMPORT_PLAYBOOK). */
export const IMPORT_PLAYBOOK_KEYS = [
  "import_playbook",
  "ansible.builtin.import_playbook",
  "ansible.legacy.import_playbook",
];

const isPlayKey = (k: string) => k === "hosts" || IMPORT_PLAYBOOK_KEYS.includes(k);

/** The import_playbook entry of a play, under any of its names (the last one written wins). */
export function importPlaybookEntry(play: YNode): YNode | undefined {
  if (play.kind !== "map") return undefined;
  for (let i = play.entries.length - 1; i >= 0; i--) {
    if (IMPORT_PLAYBOOK_KEYS.includes(play.entries[i]!.key)) return play.entries[i]!.value;
  }
  return undefined;
}

const INCLUDE_TASKS = new Set(["include_tasks", "import_tasks", "include"]);
const INCLUDE_ROLE = new Set(["include_role", "import_role"]);
const builtinName = (a: string) => a.replace(/^ansible\.(builtin|legacy)\./, "");

// --- parse_kv ---------------------------------------------------------------

/** Ansible's split_args, simplified: whitespace-separated, quotes and Jinja blocks kept whole. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const two = s.slice(i, i + 2);
    if (quote) {
      cur += c;
      if (c === "\\" && i + 1 < s.length) {
        cur += s[++i];
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (two === "{{" || two === "{%" || two === "{#") {
      depth++;
      cur += two;
      i++;
      continue;
    }
    if (depth > 0 && (two === "}}" || two === "%}" || two === "#}")) {
      depth--;
      cur += two;
      i++;
      continue;
    }
    if ((c === '"' || c === "'") && depth === 0) {
      quote = c;
      cur += c;
      continue;
    }
    if (/\s/.test(c) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function unquote(v: string): string {
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  return v;
}

/**
 * Ansible's parse_kv: `k=v` pairs, everything else joined into `_raw_params`.
 * With `checkRaw` (the free-form command modules) only the command options
 * become options; other `k=v` tokens stay in `_raw_params`, in order.
 */
export function parseKv(s: string, checkRaw = false): Record<string, string> {
  const options: Record<string, string> = {};
  const raw: string[] = [];
  for (const tok of splitArgs(s)) {
    let pos = -1;
    for (let i = 1; i < tok.length; i++) {
      if (tok[i] === "=" && tok[i - 1] !== "\\") {
        pos = i;
        break;
      }
    }
    if (pos < 0) {
      raw.push(tok.replace(/\\=/g, "="));
      continue;
    }
    const k = tok.slice(0, pos).trim();
    // A quote before the `=` means the `=` is inside a quoted string: raw text.
    if (/["']/.test(k) || (checkRaw && !CHECK_RAW_OPTIONS.has(k))) {
      raw.push(tok);
      continue;
    }
    options[k] = unquote(tok.slice(pos + 1).trim());
  }
  if (raw.length) options._raw_params = raw.join(" ");
  return options;
}

// --- Tasks ------------------------------------------------------------------

export interface ArgEntry {
  name: string;
  line: number;
  value: unknown;
  node?: YNode;
}

export interface WalkTask {
  /** Path relative to the project dir, forward slashes. */
  file: string;
  /** The action key's line (the task's reported location). */
  line: number;
  startLine: number;
  endLine: number;
  name?: string;
  role?: string;
  /** Action as written (module name, or `action:` / `local_action:` value). */
  action?: string;
  /** More than one action key (Ansible: "conflicting action statements"). */
  conflicting?: string[];
  args: ArgEntry[];
  form: "dict" | "kv" | "none";
  collections: string[];
  duplicates: { key: string; line: number }[];
  handler?: boolean;
  play?: number;
  /** include_tasks / import_tasks / include_role target. */
  include?: { kind: string; target: string; templated: boolean };
  /** Strings in the task that mention fully-qualified plugins (lookups, filters, tests). */
  pluginRefs: { kind: "lookup" | "filter" | "test"; name: string; line: number }[];
}

const PLUGIN_REF_RES: { kind: "lookup" | "filter" | "test"; re: RegExp }[] = [
  { kind: "lookup", re: /\b(?:lookup|query|q)\(\s*['"]([a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+)['"]/g },
  { kind: "filter", re: /\|\s*([a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+)\b/g },
  { kind: "test", re: /\bis\s+(?:not\s+)?([a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+)\b/g },
];

function collectPluginRefs(node: YNode | undefined, out: WalkTask["pluginRefs"]): void {
  if (!node) return;
  if (node.kind === "scalar") {
    if (typeof node.value !== "string" || !node.value.includes("{")) return;
    for (const { kind, re } of PLUGIN_REF_RES) {
      re.lastIndex = 0;
      for (const m of node.value.matchAll(re)) out.push({ kind, name: m[1]!, line: node.line });
    }
    return;
  }
  if (node.kind === "seq") for (const it of node.items) collectPluginRefs(it, out);
  else for (const e of node.entries) collectPluginRefs(e.value, out);
}

/** Extract one task from its mapping node. */
export function extractTask(
  map: YMap,
  file: string,
  doc: YamlDoc | null,
  extra: { role?: string; collections?: string[]; handler?: boolean; play?: number } = {},
): WalkTask {
  const actions = map.entries.filter((e) => !isTaskKeyword(e.key));
  const t: WalkTask = {
    file,
    line: map.line,
    startLine: map.line,
    endLine: map.endLine,
    args: [],
    form: "none",
    collections: extra.collections ?? [],
    duplicates: (doc?.duplicates ?? []).filter((d) => d.line >= map.line && d.line <= map.endLine),
    pluginRefs: [],
    ...(extra.role ? { role: extra.role } : {}),
    ...(extra.handler ? { handler: true } : {}),
    ...(extra.play !== undefined ? { play: extra.play } : {}),
  };
  const name = scalarString(get(map, "name"));
  if (name !== undefined) t.name = name;
  const coll = get(map, "collections");
  if (coll?.kind === "seq") t.collections = coll.items.map((i) => scalarString(i)).filter((x): x is string => !!x);
  collectPluginRefs(map, t.pluginRefs);

  // `action:` / `local_action:` forms.
  const actionKw = map.entries.find((e) => e.key === "action" || e.key === "local_action");
  let actionNode: YNode | undefined;
  if (actionKw) {
    const v = actionKw.value;
    t.line = actionKw.keyLine;
    if (v.kind === "scalar" && typeof v.value === "string") {
      const [mod, ...rest] = splitArgs(v.value);
      t.action = mod;
      const kv = parseKv(rest.join(" "), !!mod && isCheckRawAction(mod));
      t.form = "kv";
      t.args = Object.entries(kv).map(([k, val]) => ({ name: k, line: v.line, value: val }));
    } else if (v.kind === "map") {
      // `module:` may carry free-form args (`module: command echo a=b`).
      // Ansible splits it, parses the rest with check_raw for the free-form
      // modules, and lets those args win over the other keys.
      const modNode = get(v, "module");
      const [mod, ...rest] = splitArgs(scalarString(modNode) ?? "");
      if (mod) t.action = mod;
      t.form = "dict";
      t.args = v.entries.filter((e) => e.key !== "module").map((e) => entryArg(e.key, e.keyLine, e.value));
      if (mod && rest.length > 0) {
        const kv = parseKv(rest.join(" "), isCheckRawAction(mod));
        t.args = t.args.filter((a) => !(a.name in kv));
        for (const [k, val] of Object.entries(kv)) t.args.push({ name: k, line: modNode!.line, value: val });
      }
    }
    if (actions.length > 0) t.conflicting = [actionKw.key, ...actions.map((a) => a.key)];
  } else if (actions.length > 0) {
    const a = actions[0]!;
    t.action = a.key;
    t.line = a.keyLine;
    actionNode = a.value;
    if (actions.length > 1) t.conflicting = actions.map((x) => x.key);
  }
  if (actionNode) {
    if (actionNode.kind === "map") {
      t.form = "dict";
      t.args = actionNode.entries.map((e) => entryArg(e.key, e.keyLine, e.value));
    } else if (actionNode.kind === "scalar" && actionNode.value !== null && actionNode.value !== undefined) {
      t.form = "kv";
      const text = typeof actionNode.value === "string" ? actionNode.value : String(actionNode.value);
      t.args = Object.entries(parseKv(text, isCheckRawAction(t.action!))).map(([k, val]) => ({
        name: k,
        line: actionNode!.line,
        value: val,
      }));
    }
  }
  // `args:` adds arguments the action does not set itself: Ansible's
  // ModArgsParser updates the `args:` mapping with the action's own arguments.
  const argsKw = get(map, "args");
  if (argsKw?.kind === "map") {
    const own = new Set(t.args.map((a) => a.name));
    for (const e of argsKw.entries) {
      if (own.has(e.key)) continue;
      t.args = t.args.filter((a) => a.name !== e.key);
      t.args.push(entryArg(e.key, e.keyLine, e.value));
    }
    if (t.form === "none") t.form = "dict";
  }
  if (t.action) {
    const b = builtinName(t.action);
    if (INCLUDE_TASKS.has(b)) {
      const target = argString(t, "_raw_params") ?? argString(t, "file");
      if (target !== undefined) t.include = { kind: b, target, templated: isTemplated(target) };
    } else if (INCLUDE_ROLE.has(b)) {
      const target = argString(t, "name");
      if (target !== undefined) t.include = { kind: b, target, templated: isTemplated(target) };
    }
  }
  return t;
}

function entryArg(name: string, line: number, node: YNode): ArgEntry {
  return { name, line, value: toJS(node), node };
}

function argString(t: WalkTask, name: string): string | undefined {
  const a = t.args.find((x) => x.name === name);
  return a && typeof a.value === "string" ? a.value : undefined;
}

/** Tasks of a task list, recursing into block / rescue / always. */
export function tasksOf(
  seq: YNode | null | undefined,
  file: string,
  doc: YamlDoc | null,
  extra: Parameters<typeof extractTask>[3] = {},
): WalkTask[] {
  if (seq?.kind !== "seq") return [];
  const out: WalkTask[] = [];
  for (const item of seq.items) {
    if (item.kind !== "map") continue;
    const block = ["block", "rescue", "always"].map((k) => get(item, k)).filter((x): x is YNode => !!x);
    if (block.length > 0) {
      const coll = get(item, "collections");
      const collections =
        coll?.kind === "seq"
          ? coll.items.map((i) => scalarString(i)).filter((x): x is string => !!x)
          : (extra.collections ?? []);
      for (const b of block) out.push(...tasksOf(b, file, doc, { ...extra, collections }));
      continue;
    }
    out.push(extractTask(item, file, doc, extra));
  }
  return out;
}

/** True when a YAML root looks like a playbook: a list of mappings with hosts / import_playbook. */
export function isPlaybookRoot(root: YNode | null): boolean {
  if (root?.kind !== "seq" || root.items.length === 0) return false;
  return root.items.every((i) => i.kind === "map" && i.entries.some((e) => isPlayKey(e.key)));
}

/**
 * Looser than isPlaybookRoot, for the R1 pre-scan of directory trees: a list
 * with at least one play (hosts / import_playbook) is treated as a playbook.
 */
export function isPlaybookLike(root: YNode | null): boolean {
  if (root?.kind !== "seq") return false;
  return root.items.some((i) => i.kind === "map" && i.entries.some((e) => isPlayKey(e.key)));
}

// --- File access --------------------------------------------------------------

const MAX_YAML_BYTES = 2 * 1024 * 1024;

export class ProjectFiles {
  /** Per path: the parsed doc (null when unread), and the file size (undefined when not a readable file). */
  private readonly cache = new Map<string, { doc: YamlDoc | null; size: number | undefined }>();
  constructor(readonly dir: string) {}

  /** An absolute input is returned unchanged (a playbook outside dir); a relative one joins dir. */
  abs(rel: string): string {
    return isAbsolute(rel) ? rel : join(this.dir, rel);
  }

  /** Relative to dir when inside it (drive-letter / case-insensitive on Windows), else the forward-slashed path. */
  rel(abs: string): string {
    const a = abs.replace(/\\/g, "/");
    const b = this.dir.replace(/\\/g, "/").replace(/\/+$/, "");
    const fold = (x: string) => (process.platform === "win32" ? x.toLowerCase() : x);
    return fold(a).startsWith(fold(`${b}/`)) ? a.slice(b.length + 1) : a;
  }

  /** Parse a YAML file of at most `maxBytes` (default 2 MiB); null when missing, unreadable or larger. */
  read(abs: string, maxBytes = MAX_YAML_BYTES): YamlDoc | null {
    const hit = this.cache.get(abs);
    if (hit && (hit.size === undefined || hit.size > maxBytes)) return null;
    if (hit?.doc) return hit.doc;
    let doc: YamlDoc | null = null;
    let size: number | undefined;
    try {
      const st = statSync(abs);
      if (st.isFile()) {
        size = st.size;
        if (st.size <= maxBytes) doc = parseYaml(readFileSync(abs, "utf8"));
      }
    } catch {
      doc = null;
      size = undefined;
    }
    this.cache.set(abs, { doc, size });
    return doc;
  }
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `main.yml`, `main.yaml` or `main` (dir) in `dir/sub`. */
export function findMain(dir: string, sub: string, base = "main"): string | null {
  for (const ext of [".yml", ".yaml", ""]) {
    const p = join(dir, sub, `${base}${ext}`);
    if (ext && isFile(p)) return p;
  }
  return null;
}

// --- Role resolution ------------------------------------------------------------

export function resolveRole(name: string, searchDirs: string[]): string | null {
  if (/^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/.test(name)) return null; // collection role: not followed in v0.1
  for (const base of searchDirs) {
    const p = join(base, name);
    if (isDir(p) && (isDir(join(p, "tasks")) || isDir(join(p, "meta")) || isDir(join(p, "defaults")))) return p;
  }
  return null;
}

export interface RoleDep {
  name: string;
  vars: string[];
}

export function roleDependencies(roleDir: string, files: ProjectFiles): RoleDep[] {
  const meta = findMain(roleDir, "meta");
  if (!meta) return [];
  const deps = get(files.read(meta)?.root, "dependencies");
  if (deps?.kind !== "seq") return [];
  const out: RoleDep[] = [];
  for (const d of deps.items) {
    if (d.kind === "scalar" && typeof d.value === "string") out.push({ name: d.value, vars: [] });
    else if (d.kind === "map") {
      const n = scalarString(get(d, "role")) ?? scalarString(get(d, "name"));
      if (!n) continue;
      const v = get(d, "vars");
      const vars = v?.kind === "map" ? v.entries.map((e) => e.key) : [];
      // Old style: params at the dependency's top level.
      const inline = d.entries
        .filter((e) => !["role", "name", "vars", "when", "tags", "become", "delegate_to"].includes(e.key))
        .map((e) => e.key);
      out.push({ name: n, vars: [...vars, ...inline] });
    }
  }
  return out;
}

// --- The walk -------------------------------------------------------------------

export interface PlayInfo {
  file: string;
  index: number;
  line: number;
  name?: string;
  hosts?: string;
  roles: string[];
  deps: string[];
}

export interface WalkResult {
  tasks: WalkTask[];
  plays: PlayInfo[];
  notFollowed: string[];
  /** Roles walked: name -> project-relative dir. */
  roles: Map<string, string>;
}

export interface WalkOptions {
  /** Server-side roles_path entries (from config), searched first. */
  rolesPaths: string[];
}

export function walkPlaybooks(files: ProjectFiles, playbooks: string[], opts: WalkOptions): WalkResult {
  const res: WalkResult = { tasks: [], plays: [], notFollowed: [], roles: new Map() };
  const seenTask = new Set<string>();
  const seenPlaybook = new Set<string>();
  const add = (ts: WalkTask[]) => {
    for (const t of ts) {
      const k = `${t.file}:${t.startLine}`;
      if (seenTask.has(k)) continue;
      seenTask.add(k);
      res.tasks.push(t);
    }
  };

  const walkTaskFile = (
    abs: string,
    ctx: { role?: string; roleDir?: string; collections: string[]; play: number; handler?: boolean },
    stack: string[],
  ) => {
    if (stack.includes(abs) || stack.length > 20) return;
    const doc = files.read(abs);
    if (!doc) return;
    const rel = files.rel(abs);
    const ts = tasksOf(doc.root, rel, doc, {
      role: ctx.role,
      collections: ctx.collections,
      handler: ctx.handler,
      play: ctx.play,
    });
    for (const t of ts) {
      add([t]);
      if (!t.include) continue;
      const { kind, target, templated } = t.include;
      if (templated) {
        res.notFollowed.push(`${t.file}:${t.line} ${kind} "${target}"`);
        continue;
      }
      if (kind === "include_role" || kind === "import_role") {
        walkRole(target, ctx, dirname(abs), [...stack, abs]);
        continue;
      }
      const bases = ctx.roleDir ? [join(ctx.roleDir, "tasks"), dirname(abs)] : [dirname(abs)];
      const found = bases.map((b) => join(b, target)).find(isFile);
      if (found) walkTaskFile(found, ctx, [...stack, abs]);
      else res.notFollowed.push(`${t.file}:${t.line} ${kind} "${target}" (file not found)`);
    }
  };

  const roleSearch = (fromDir: string) => [
    ...opts.rolesPaths,
    join(fromDir, "roles"),
    join(files.dir, "roles"),
    fromDir,
    files.dir,
  ];

  const walkRole = (
    name: string,
    ctx: { collections: string[]; play: number },
    fromDir: string,
    stack: string[],
    deps?: string[],
  ) => {
    const roleDir = resolveRole(name, roleSearch(fromDir));
    if (!roleDir) {
      if (!/^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/.test(name)) res.notFollowed.push(`role ${name} (not found)`);
      return;
    }
    if (stack.includes(roleDir) || stack.length > 20) return;
    const roleName = name.split("/").pop()!;
    res.roles.set(roleName, files.rel(roleDir));
    for (const dep of roleDependencies(roleDir, files)) {
      deps?.push(dep.name);
      walkRole(dep.name, ctx, fromDir, [...stack, roleDir], deps);
    }
    const coll = get(files.read(findMain(roleDir, "meta") ?? "")?.root, "collections");
    const collections =
      coll?.kind === "seq" ? coll.items.map((i) => scalarString(i)).filter((x): x is string => !!x) : ctx.collections;
    const rctx = { role: roleName, roleDir, collections, play: ctx.play };
    const tasks = findMain(roleDir, "tasks");
    if (tasks) walkTaskFile(tasks, rctx, [...stack, roleDir]);
    const handlers = findMain(roleDir, "handlers");
    if (handlers) walkTaskFile(handlers, { ...rctx, handler: true }, [...stack, roleDir]);
  };

  const walkPlaybook = (abs: string) => {
    if (seenPlaybook.has(abs)) return;
    seenPlaybook.add(abs);
    const doc = files.read(abs);
    const root = doc?.root;
    if (!doc || root?.kind !== "seq") return;
    const rel = files.rel(abs);
    for (const play of root.items) {
      if (play.kind !== "map") continue;
      const imp = importPlaybookEntry(play);
      if (imp) {
        const target = scalarString(imp);
        if (target && !isTemplated(target)) {
          const p = join(dirname(abs), target);
          if (isFile(p)) walkPlaybook(p);
          else res.notFollowed.push(`${rel}:${imp.line} import_playbook "${target}" (file not found)`);
        } else if (target) {
          res.notFollowed.push(`${rel}:${imp.line} import_playbook "${target}"`);
        }
        continue;
      }
      const index = res.plays.length + 1;
      const coll = get(play, "collections");
      const collections =
        coll?.kind === "seq" ? coll.items.map((i) => scalarString(i)).filter((x): x is string => !!x) : [];
      const info: PlayInfo = { file: rel, index, line: play.line, roles: [], deps: [] };
      const pn = scalarString(get(play, "name"));
      if (pn !== undefined) info.name = pn;
      const hosts = get(play, "hosts");
      if (hosts) info.hosts = hosts.kind === "seq" ? (toJS(hosts) as unknown[]).join(",") : scalarString(hosts);
      res.plays.push(info);
      const ctx = { collections, play: index };
      const fromDir = dirname(abs);
      const pre = get(play, "pre_tasks");
      if (pre) walkInline(pre, abs, rel, doc, ctx, fromDir);
      const roles = get(play, "roles");
      if (roles?.kind === "seq") {
        for (const r of roles.items) {
          const n =
            r.kind === "scalar" ? scalarString(r) : (scalarString(get(r, "role")) ?? scalarString(get(r, "name")));
          if (!n) continue;
          info.roles.push(n);
          walkRole(n, ctx, fromDir, [], info.deps);
        }
      }
      for (const key of ["tasks", "post_tasks"]) {
        const list = get(play, key);
        if (list) walkInline(list, abs, rel, doc, ctx, fromDir);
      }
      const handlers = get(play, "handlers");
      if (handlers) walkInline(handlers, abs, rel, doc, { ...ctx, handler: true }, fromDir);
    }
  };

  const walkInline = (
    list: YNode,
    abs: string,
    rel: string,
    doc: YamlDoc,
    ctx: { collections: string[]; play: number; handler?: boolean },
    fromDir: string,
  ) => {
    const ts = tasksOf(list, rel, doc, ctx);
    for (const t of ts) {
      add([t]);
      if (!t.include) continue;
      const { kind, target, templated } = t.include;
      if (templated) {
        res.notFollowed.push(`${t.file}:${t.line} ${kind} "${target}"`);
      } else if (kind === "include_role" || kind === "import_role") {
        walkRole(target, ctx, fromDir, [abs]);
      } else {
        const p = join(fromDir, target);
        if (isFile(p)) walkTaskFile(p, ctx, [abs]);
        else res.notFollowed.push(`${t.file}:${t.line} ${kind} "${target}" (file not found)`);
      }
    }
  };

  for (const pb of playbooks) walkPlaybook(files.abs(pb));
  return res;
}

// --- Detection ----------------------------------------------------------------

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", ".tox", "__pycache__", ".cache", ".github"]);

export interface Detected {
  playbooks: { rel: string; plays: number }[];
  inventories: { rel: string; kind: string }[];
  roles: { name: string; rel: string; argumentSpecs: boolean }[];
  requirements: string[];
  configFiles: string[];
  localCollections: boolean;
}

function walkFiles(dir: string, depth: number, out: string[], base = dir): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name === "collections" && dir === base) continue;
      if (depth > 0) walkFiles(p, depth - 1, out, base);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
}

/**
 * Dirs the R1 tree walk skips: only ansible-lint's default exclude_paths, so
 * the pre-scan sees at least everything lint can (lint lists files through
 * `git ls-files --cached --others`, which includes untracked node_modules or
 * venv trees). A project's own exclude_paths are not honoured: scanning more is safe.
 */
const TREE_SKIP_DIRS = new Set([".cache", ".git", ".hg", ".svn", ".tox"]);
/** Safety bound on directory entries the R1 tree walk looks at. */
const TREE_MAX_ENTRIES = 200_000;

/**
 * Every .yml/.yaml file under `dir` at any depth (symlinked dirs followed once,
 * by real path), for the R1 pre-scan of lint targets. `incomplete` says why the
 * walk could not see everything (the entry bound, or a dir it could not list).
 */
export function yamlFilesUnder(dir: string, maxEntries = TREE_MAX_ENTRIES): { files: string[]; incomplete?: string } {
  const files: string[] = [];
  const realSeen = new Set<string>();
  let entriesSeen = 0;
  let incomplete: string | undefined;
  const walk = (d: string): void => {
    if (incomplete) return;
    try {
      const real = realpathSync(d);
      if (realSeen.has(real)) return;
      realSeen.add(real);
    } catch {
      incomplete = `could not be fully listed (${d})`;
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      incomplete = `could not be fully listed (${d})`;
      return;
    }
    for (const e of entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
      if (++entriesSeen > maxEntries) {
        incomplete = `has more than ${maxEntries} entries to pre-scan`;
        return;
      }
      const p = join(d, e.name);
      let isDirEntry = e.isDirectory();
      let isFileEntry = e.isFile();
      if (e.isSymbolicLink()) {
        isDirEntry = isDir(p);
        isFileEntry = isFile(p);
      }
      if (isDirEntry) {
        if (!TREE_SKIP_DIRS.has(e.name)) walk(p);
      } else if (isFileEntry && /\.ya?ml$/i.test(e.name)) {
        files.push(p);
      }
      if (incomplete) return;
    }
  };
  walk(dir);
  return incomplete ? { files, incomplete } : { files };
}

/** Minimal INI read of ansible.cfg [defaults] (static half of project_info; no Ansible needed). */
export function readCfgStatic(dir: string): Record<string, string> {
  const p = join(dir, "ansible.cfg");
  if (!isFile(p)) return {};
  const out: Record<string, string> = {};
  let section = "";
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const s = /^\[(.+)\]$/.exec(line);
    if (s) {
      section = s[1]!.trim();
      continue;
    }
    const kv = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
    if (kv && section === "defaults") out[kv[1]!.trim()] = kv[2]!.trim();
  }
  return out;
}

function inventoryKind(abs: string, files: ProjectFiles): string {
  if (isDir(abs)) return "dir";
  if (/\.(ya?ml|json)$/i.test(abs)) {
    const plugin = scalarString(get(files.read(abs)?.root, "plugin"));
    return plugin ? `plugin config: ${plugin}` : "yaml";
  }
  if (/\.(sh|py|pl|rb)$/i.test(abs)) return "script";
  return "ini";
}

export function detectProject(dir: string, cfgInventory: string[] = []): Detected {
  const files = new ProjectFiles(dir);
  const all: string[] = [];
  walkFiles(dir, 3, all);
  const det: Detected = {
    playbooks: [],
    inventories: [],
    roles: [],
    requirements: [],
    configFiles: [],
    localCollections: isDir(join(dir, "collections", "ansible_collections")),
  };
  const invSeen = new Set<string>();
  const addInv = (abs: string, note = "") => {
    const rel = files.rel(abs);
    if (invSeen.has(rel)) return;
    invSeen.add(rel);
    det.inventories.push({ rel, kind: `${inventoryKind(abs, files)}${note}` });
  };
  for (const inv of cfgInventory) {
    const abs = /^[\\/]|^[A-Za-z]:/.test(inv) ? inv : join(dir, inv);
    if (existsSync(abs)) addInv(abs, ", from ansible.cfg");
  }
  for (const d of ["inventory", "inventories"]) {
    if (isDir(join(dir, d)) && ![...invSeen].some((r) => r.startsWith(`${d}/`))) addInv(join(dir, d));
  }
  const roleDirs = new Set<string>();
  for (const abs of all.sort()) {
    const rel = files.rel(abs);
    const base = posix.basename(rel);
    if (["ansible.cfg", ".ansible-lint", "execution-environment.yml", "ansible-navigator.yml"].includes(base)) {
      det.configFiles.push(rel);
    }
    if (/^(requirements\.ya?ml|collections\/requirements\.ya?ml|roles\/requirements\.ya?ml)$/.test(rel)) {
      det.requirements.push(rel);
    }
    const m = /^(.*)\/(tasks|meta)\/main\.ya?ml$/.exec(rel);
    if (m && !/(^|\/)(tasks|handlers|vars|defaults|meta|templates|files)\//.test(`${m[1]}/`)) roleDirs.add(m[1]!);
    if (/^hosts(\.\w+)?$/.test(base) || (/\.ini$/i.test(base) && base !== "ansible.cfg")) {
      if (!rel.includes("/") || rel.split("/").length <= 2) addInv(abs);
    }
    if (/\.ya?ml$/i.test(base) && !/(^|\/)(roles|group_vars|host_vars)\//.test(rel)) {
      const doc = files.read(abs);
      if (isPlaybookRoot(doc?.root ?? null)) {
        det.playbooks.push({ rel, plays: (doc!.root as { items: unknown[] }).items.length });
      } else if (doc?.root?.kind === "map" && get(doc.root, "all") && !rel.startsWith("inventor")) {
        addInv(abs);
      }
    }
  }
  for (const r of [...roleDirs].sort()) {
    det.roles.push({
      name: posix.basename(r),
      rel: r,
      argumentSpecs:
        isFile(join(dir, r, "meta", "argument_specs.yml")) ||
        isFile(join(dir, r, "meta", "argument_specs.yaml")) ||
        !!get(files.read(findMain(join(dir, r), "meta") ?? "")?.root, "argument_specs"),
    });
  }
  return det;
}

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { BAD_TYPE_MESSAGE, collectionsPathOf, isPluginType, type PluginDoc, renderModuleDoc } from "./ansibleDoc.js";
import { checkTask, docNamesFor, renderChecks, resolveTaskDoc } from "./checkArgs.js";
import {
  byCollection,
  parseCollectionList,
  parseRequirements,
  parseRoleList,
  renderCollections,
} from "./collections.js";
import { configFile, renderConfig, settingList } from "./config.js";
import type { AnsibleContext, Project } from "./context.js";
import { NATIVE_WINDOWS_MESSAGE, stripAnsi } from "./exec.js";
import {
  graphStats,
  groupsOf,
  hostMissing,
  isVaultFailure,
  type ListDoc,
  learnAll,
  parseGraph,
  renderGraph,
  renderHostVars,
  renderVarNames,
  renderVarsFilesFallback,
  skippedSources,
  VARS_SCOPE_NOTE,
  varsFiles,
} from "./inventory.js";
import { parseCodeclimate, renderLint } from "./lint.js";
import { PlainAnswer, relativeTo } from "./paths.js";
import {
  localPluginFiles,
  parseListOutput,
  parseStderrMessages,
  prescanLintTargets,
  prescanPlaybook,
  prescanRefusal,
} from "./playbook.js";
import {
  detectProject,
  extractTask,
  isDir,
  isFile,
  isPlaybookRoot,
  ProjectFiles,
  readCfgStatic,
  resolveRole,
  tasksOf,
  type WalkTask,
  walkPlaybooks,
} from "./project.js";
import { Redactor, redactText } from "./redact.js";
import { argSpecsFile, renderRole, roleSpecsFromDocJson, roleSpecsFromNode, yaml11Choices } from "./role.js";
import { get, parseYaml, scalarString } from "./yaml.js";

/** Tool bodies. Each returns the text to print; a thrown PlainAnswer is printed as a fact, anything else is an error. */

function refuseDash(param: string, v: string | undefined): void {
  if (v?.trim().startsWith("-")) throw new PlainAnswer(`${param} must not start with '-'`);
}

function assertRelative(ctx: AnsibleContext, p: Project, rel: string, what: string): string {
  ctx.runner.assertLocal(rel);
  refuseDash(what, rel);
  // Normalization turns `./--fix` or `a/../--fix` into `--fix`: check that form too.
  refuseDash(what, normalize(rel.trim()));
  const abs = /^[A-Za-z]:[\\/]|^\//.test(rel) ? rel : join(p.dir, rel);
  ctx.runner.assertLocal(abs);
  return abs;
}

const plural = (n: number, w: string, pl = `${w}s`) => `${n} ${n === 1 ? w : pl}`;

// --- ansible_project_info -------------------------------------------------------

export async function projectInfo(ctx: AnsibleContext, dir?: string): Promise<string> {
  const p = await ctx.project(dir);
  const staticCfg = readCfgStatic(p.dir);
  const lines: string[] = [];
  let cfgInventory: string[] = staticCfg.inventory ? staticCfg.inventory.split(",").map((s) => s.trim()) : [];
  let rolesPath = staticCfg.roles_path ?? "";
  if (ctx.runner.available()) {
    try {
      const [ver, cfg, bins] = await Promise.all([ctx.version(), ctx.config(p), probeBinaries(ctx)]);
      cfgInventory = settingList(cfg, "DEFAULT_HOST_LIST").map((s) => ctx.rel(p, s));
      const cf = configFile(cfg);
      lines.push(
        `ansible project ${p.dir} (ansible-core ${ver.core}${ctx.runner.label()}, python ${ver.python || "?"}, jinja ${ver.jinja || "?"})`,
      );
      lines.push(`config file: ${cf ? ctx.rel(p, cf) : "(none)"}${p.drvfsNote ? ` [${p.drvfsNote}]` : ""}`);
      lines.push(
        `collections paths: ${
          settingList(cfg, "COLLECTIONS_PATHS")
            .map((c) => ctx.runner.displaySide(c))
            .join(", ") || "(none)"
        }`,
      );
      rolesPath = settingList(cfg, "DEFAULT_ROLES_PATH")
        .map((r) => ctx.rel(p, r))
        .join(", ");
      lines.push(`roles path: ${rolesPath || "(default)"}`);
      lines.push(`binaries: ${bins}`);
    } catch (e) {
      lines.push(`ansible project ${p.dir} (Ansible not usable: ${e instanceof Error ? e.message : String(e)})`);
    }
  } else {
    lines.push(`ansible project ${p.dir} (static view only)`);
    if (staticCfg.inventory || staticCfg.roles_path) {
      lines.push(
        `ansible.cfg (static read): inventory=${staticCfg.inventory ?? "-"} roles_path=${staticCfg.roles_path ?? "-"}`,
      );
    }
  }
  const det = detectProject(p.dir, cfgInventory);
  lines.push(
    `playbooks (${det.playbooks.length}): ${det.playbooks.map((pb) => `${pb.rel} (${plural(pb.plays, "play")})`).join(", ") || "(none found)"}`,
  );
  let vaultCount = 0;
  const bases = new Set<string>([p.dir]);
  for (const inv of det.inventories) {
    const abs = join(p.dir, inv.rel);
    bases.add(isDir(abs) ? abs : dirname(abs));
  }
  for (const b of bases) {
    for (const f of varsFiles(b)) {
      try {
        if (/^\s*\$ANSIBLE_VAULT;/.test(readFileSync(f.abs, "utf8").slice(0, 64))) vaultCount++;
      } catch {
        // unreadable: skip
      }
    }
  }
  const vaultNote = vaultCount ? ` + group_vars/host_vars (${plural(vaultCount, "whole-file vault")})` : "";
  lines.push(
    `inventories (${det.inventories.length}): ${det.inventories.map((i) => `${i.rel} (${i.kind})`).join(", ") || "(none found)"}${vaultNote}`,
  );
  lines.push(
    `roles (${det.roles.length}): ${det.roles.map((r) => `${r.name}${r.argumentSpecs ? " [argument_specs]" : ""}`).join(", ") || "(none found)"}`,
  );
  if (det.requirements.length) {
    const parts = det.requirements.map((f) => {
      const r = parseRequirements(new ProjectFiles(p.dir).read(join(p.dir, f))?.root, f);
      return `${f} (${plural(r.collections.length, "collection")}, ${plural(r.roles.length, "role")})`;
    });
    lines.push(`requirements: ${parts.join(", ")}`);
  } else {
    lines.push("requirements: (none found)");
  }
  const other = det.configFiles.filter((f) => f !== "ansible.cfg");
  if (other.length) lines.push(`also: ${other.join(", ")}`);
  if (det.localCollections) lines.push("project-local collections: collections/ansible_collections");
  if (!ctx.runner.available()) lines.push(`note: ${NATIVE_WINDOWS_MESSAGE}`);
  const footer = ctx.runner.available() ? await ctx.footer(p) : "";
  if (footer) lines.push(footer);
  return lines.join("\n");
}

async function listBinDir(ctx: AnsibleContext): Promise<string[] | null> {
  const dir = ctx.runner.cfg.binDir!;
  try {
    if (!ctx.runner.prefixed) return readdirSync(dir);
    const r = await ctx.runner.raw("ls", ["-1", "--", dir], {});
    return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : null;
  } catch {
    return null;
  }
}

async function probeBinaries(ctx: AnsibleContext): Promise<string> {
  const tools = [
    "ansible-doc",
    "ansible-inventory",
    "ansible-playbook",
    "ansible-galaxy",
    "ansible-config",
    "ansible-lint",
  ];
  // With a BIN_DIR, one listing replaces five `--version` spawns (each one is
  // 200-700 ms through wsl.exe, F23); only ansible-lint is asked for its version.
  const listed = ctx.runner.cfg.binDir ? await listBinDir(ctx) : null;
  const quiet = await ctx.quietEnv();
  const res = await Promise.all(
    tools.map(async (t) => {
      if (listed && t !== "ansible-lint") return { t, ok: listed.includes(t), v: "" };
      if (listed && !listed.includes(t)) return { t, ok: false, v: "" };
      try {
        const r = await ctx.runner.run(t, t === "ansible-lint" ? ["--version", "--offline"] : ["--version"], {
          env: quiet,
        });
        if (r.code !== 0) return { t, ok: false, v: "" };
        const v = t === "ansible-lint" ? (/ansible-lint\s+([\d.]+)/.exec(stripAnsi(r.stdout))?.[1] ?? "") : "";
        return { t, ok: true, v };
      } catch {
        return { t, ok: false, v: "" };
      }
    }),
  );
  const ok = res.filter((r) => r.ok).map((r) => (r.v ? `${r.t} ${r.v}` : r.t));
  const missing = res.filter((r) => !r.ok).map((r) => r.t);
  return `${ok.join(" ") || "(none)"}${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`;
}

// --- ansible_module_doc -----------------------------------------------------------

export interface ModuleDocParams {
  name: string;
  type: string;
  dir?: string;
  includeReturn: boolean;
  includeExamples: boolean;
  descriptionChars: number;
}

export async function moduleDoc(ctx: AnsibleContext, x: ModuleDocParams): Promise<string> {
  const name = x.name.trim();
  refuseDash("name", name);
  if (!isPluginType(x.type)) return BAD_TYPE_MESSAGE;
  if (x.type === "role") return "for roles, use ansible_role_interface (argument specs, defaults and dependencies)";
  const p = await ctx.project(x.dir);
  if (x.type === "keyword") {
    const r = await ctx.runSafe(p, "ansible-doc", ["--json", "-t", "keyword", name]);
    let kw: Record<string, any> = {};
    try {
      kw = JSON.parse(r.stdout || "{}");
    } catch {
      kw = {};
    }
    const k = kw[name];
    if (!k) return `keyword '${name}' is not a playbook keyword in ansible-core ${(await ctx.version()).core}`;
    return [
      `${name} (keyword, ansible-core ${(await ctx.version()).core}) - ${String(k.description ?? "").replace(/\s+/g, " ")}`,
      `applies to: ${(k.applies_to ?? []).join(", ")}${k.type ? ` | type: ${k.type}` : ""}${k.template ? ` | templating: ${k.template}` : ""}`,
    ].join("\n");
  }
  const docs = await ctx.docs(p, [name], { type: x.type });
  const doc = docs.docs.get(name);
  if (!doc) {
    const tomb = docs.tombstones.find((t) => t.name === name);
    if (tomb) return `${name} was removed from ${tomb.collection} in ${tomb.version}: ${tomb.text}`;
    const dep = docs.deprecations.find((d) => d.name === name);
    if (dep)
      return `${name} is deprecated and could not be found: ${dep.text} The collection it moved to is not installed.`;
    const cfg = await ctx.config(p);
    const paths = settingList(cfg, "COLLECTIONS_PATHS").map((c) => ctx.runner.displaySide(c));
    return `${name} (${x.type}) is not installed (searched: ${paths.join(", ") || "the default collections paths"}). Try ansible_module_search.`;
  }
  const { source, majorFloor } = await docSource(ctx, p, doc);
  return renderModuleDoc({
    doc,
    type: x.type,
    asked: name,
    source,
    includeReturn: x.includeReturn,
    includeExamples: x.includeExamples,
    descriptionChars: x.descriptionChars,
    majorFloor,
  });
}

async function docSource(
  ctx: AnsibleContext,
  p: Project,
  doc: PluginDoc,
): Promise<{ source: string; majorFloor: string | null }> {
  if (doc.collection === "ansible.builtin" || !doc.collection) {
    return { source: `ansible-core ${(await ctx.version()).core}`, majorFloor: null };
  }
  const r = await ctx.runSafe(p, "ansible-galaxy", ["collection", "list", doc.collection, "--format", "json"]);
  const list = r.code === 0 ? parseCollectionList(r.stdout) : [];
  const where = collectionsPathOf(doc.filename);
  const hit = list.find((i) => where && i.path.replace(/\/ansible_collections\/?$/, "") === where) ?? list[0];
  const v = hit?.version;
  const major = v ? /^(\d+)/.exec(v)?.[1] : undefined;
  return { source: `${doc.collection}${v ? ` ${v}` : ""}`, majorFloor: major ? `${major}.0.0` : null };
}

// --- ansible_module_search ----------------------------------------------------------

export async function moduleSearch(
  ctx: AnsibleContext,
  x: { query?: string; collection?: string; type: string; dir?: string; limit: number },
): Promise<string> {
  if (!isPluginType(x.type) || x.type === "role") return BAD_TYPE_MESSAGE;
  refuseDash("collection", x.collection);
  const p = await ctx.project(x.dir);
  const q = x.query?.trim().toLowerCase() ?? "";
  if (!q && !x.collection) {
    const all = await ctx.listPlugins(p, x.type);
    return `pass query or collection (${Object.keys(all).length} ${x.type} plugins installed)`;
  }
  const list = await ctx.listPlugins(p, x.type, x.collection?.trim());
  const scored: { name: string; desc: string; score: number }[] = [];
  for (const [name, desc] of Object.entries(list)) {
    const n = name.toLowerCase();
    const short = n.split(".").pop() ?? n;
    const d = String(desc ?? "").toLowerCase();
    let score = -1;
    if (!q) score = 5;
    else if (n === q || short === q) score = 0;
    else if (short.startsWith(q)) score = 1;
    else if (short.split("_").includes(q)) score = 2;
    else if (n.includes(q)) score = 3;
    else if (q.split(/\s+/).every((w) => d.includes(w) || n.includes(w))) score = 4;
    if (score >= 0) scored.push({ name, desc: String(desc ?? ""), score });
  }
  scored.sort((a, b) => a.score - b.score || (a.name < b.name ? -1 : 1));
  const label = x.query ? `'${x.query}'` : `collection ${x.collection}`;
  if (scored.length === 0)
    return `no ${x.type} plugins match ${label}${x.collection && x.query ? ` in ${x.collection}` : ""}`;
  const lines = [`${scored.length} match${scored.length === 1 ? "" : "es"} for ${label} (${x.type}):`];
  for (const s of scored.slice(0, x.limit)) lines.push(`${s.name} - ${s.desc.replace(/\s+/g, " ")}`);
  if (scored.length > x.limit) lines.push(`... ${scored.length - x.limit} more, narrow the query`);
  return lines.join("\n");
}

// --- ansible_check_task_args ----------------------------------------------------------

export async function checkTaskArgs(
  ctx: AnsibleContext,
  x: { task?: string; file?: string; line?: number; dir?: string },
): Promise<string> {
  if ((x.task === undefined) === (x.file === undefined))
    return "pass exactly one of task (YAML) or file (path relative to dir)";
  const p = await ctx.project(x.dir);
  let tasks: WalkTask[];
  let label: string;
  if (x.file !== undefined) {
    const abs = assertRelative(ctx, p, x.file, "file");
    if (!isFile(abs)) return `${x.file} does not exist or is not a file in ${p.dir}`;
    const files = new ProjectFiles(p.dir);
    const doc = files.read(abs);
    if (!doc) return `${x.file} could not be read as YAML`;
    if (doc.errors.length) return `${x.file}: YAML error: ${doc.errors[0]}`;
    label = files.rel(abs);
    tasks = tasksFromRoot(doc.root, label, doc);
  } else {
    const doc = parseYaml(x.task!);
    if (doc.errors.length) return `task: YAML error: ${doc.errors[0]}`;
    label = "task";
    tasks = doc.root?.kind === "map" ? [extractTask(doc.root, label, doc)] : tasksFromRoot(doc.root, label, doc);
  }
  let scope: string | undefined;
  if (x.line !== undefined) {
    tasks = tasks.filter((t) => t.startLine <= x.line! && t.endLine >= x.line!);
    scope = `(task at line ${x.line})`;
    if (tasks.length === 0) return `${label}: no task spans line ${x.line}`;
  }
  ctx.runner.assertAvailable();
  const docs = await ctx.docs(p, docNamesFor(tasks));
  const checks = tasks.map((t) => checkTask(t, docs));
  return renderChecks(label, await ctx.coreLabel(), checks, scope);
}

function tasksFromRoot(
  root: ReturnType<typeof parseYaml>["root"],
  file: string,
  doc: ReturnType<typeof parseYaml>,
): WalkTask[] {
  if (!isPlaybookRoot(root)) return tasksOf(root ?? undefined, file, doc);
  const out: WalkTask[] = [];
  if (root?.kind !== "seq") return out;
  root.items.forEach((play, i) => {
    if (play.kind !== "map") return;
    const coll = get(play, "collections");
    const collections =
      coll?.kind === "seq" ? coll.items.map((c) => scalarString(c)).filter((s): s is string => !!s) : [];
    for (const key of ["pre_tasks", "tasks", "post_tasks", "handlers"]) {
      out.push(...tasksOf(get(play, key), file, doc, { collections, play: i + 1, handler: key === "handlers" }));
    }
  });
  return out;
}

// --- ansible_role_interface ---------------------------------------------------------------

export async function roleInterface(
  ctx: AnsibleContext,
  x: { role: string; dir?: string; entryPoint?: string; descriptionChars: number },
): Promise<string> {
  const role = x.role.trim();
  refuseDash("role", role);
  ctx.runner.assertLocal(role);
  const p = await ctx.project(x.dir);
  const files = new ProjectFiles(p.dir);
  if (/^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/.test(role)) {
    ctx.runner.assertAvailable();
    const r = await ctx.runSafe(p, "ansible-doc", ["--json", "-t", "role", role]);
    const parsed = r.code === 0 ? roleSpecsFromDocJson(r.stdout, role) : null;
    if (!parsed)
      return `collection role ${role} was not found (or has no argument specs): ${r.stderr.trim().split("\n")[0] ?? ""}`;
    return renderRole({
      name: role,
      origin: `collection ${parsed.collection ?? role.split(".").slice(0, 2).join(".")}`,
      specs: parsed.specs,
      specsSource: "ansible-doc",
      roleDir: null,
      files: null,
      ...(x.entryPoint ? { entryPoint: x.entryPoint } : {}),
      descriptionChars: x.descriptionChars,
      yaml11: [],
    });
  }
  let rolesPaths: string[] = [];
  if (ctx.runner.available()) {
    try {
      rolesPaths = settingList(await ctx.config(p), "DEFAULT_ROLES_PATH")
        .map((s) => ctx.runner.serverPathOf(s))
        .filter((s): s is string => !!s);
    } catch {
      rolesPaths = [];
    }
  } else {
    const rp = readCfgStatic(p.dir).roles_path;
    if (rp) rolesPaths = rp.split(":").map((s) => join(p.dir, s));
  }
  const search = [...rolesPaths, join(p.dir, "roles"), p.dir];
  const roleDir = resolveRole(role, search);
  if (!roleDir) return `role ${role} not found (searched: ${search.map((s) => files.rel(s) || ".").join(", ")})`;
  const specFile = argSpecsFile(roleDir);
  const specRoot = specFile ? files.read(specFile)?.root : null;
  let specs = null;
  let source = "meta/argument_specs.yml";
  if (ctx.runner.available()) {
    const base = roleDir
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop()!;
    // The basename is a positional ansible-doc argument: never one that reads as an option.
    refuseDash("role", base);
    try {
      const sideParent = await ctx.runner.toSide(dirname(roleDir));
      const r = await ctx.runSafe(p, "ansible-doc", ["--json", "-t", "role", "-r", sideParent, base]);
      if (r.code === 0) {
        specs = roleSpecsFromDocJson(r.stdout, base)?.specs ?? null;
        if (specs) source = "ansible-doc";
      }
    } catch {
      specs = null;
    }
  }
  specs ??= roleSpecsFromNode(specRoot);
  return renderRole({
    name: role.split("/").pop()!,
    origin: `local, ${files.rel(roleDir)}`,
    specs,
    specsSource: specFile ? source : "no meta/argument_specs.yml",
    roleDir,
    files,
    ...(x.entryPoint ? { entryPoint: x.entryPoint } : {}),
    descriptionChars: x.descriptionChars,
    yaml11: yaml11Choices(specRoot),
  });
}

// --- ansible_inventory ------------------------------------------------------------------

export async function inventory(
  ctx: AnsibleContext,
  x: { dir?: string; inventory?: string; host?: string; group?: string; vars?: string; limit: number },
): Promise<string> {
  refuseDash("host", x.host);
  refuseDash("group", x.group);
  const varsMode = x.vars ?? (x.host ? "values" : "names");
  if (!["none", "names", "values"].includes(varsMode)) return "vars must be one of none, names, values";
  ctx.runner.assertAvailable();
  const p = await ctx.project(x.dir);
  const iArgs: string[] = [];
  let label: string;
  let sources: string[];
  const cfg = await ctx.config(p);
  if (x.inventory) {
    const abs = assertRelative(ctx, p, x.inventory, "inventory");
    iArgs.push("-i", await ctx.runner.toSide(abs));
    label = x.inventory;
    sources = [abs];
  } else {
    const list = settingList(cfg, "DEFAULT_HOST_LIST");
    label = list.map((s) => ctx.rel(p, s)).join(", ") || "(default)";
    sources = list.map((s) => ctx.runner.serverPathOf(s)).filter((s): s is string => !!s);
  }
  const core = await ctx.coreLabel();
  const graph = await ctx.runSafe(p, "ansible-inventory", ["--graph", ...(x.group ? [x.group] : []), ...iArgs]);
  if (graph.code !== 0) {
    throw new Error(
      `ansible-inventory --graph failed (exit ${graph.code}):\n${redactText(graph.stderr.trim()).slice(0, 2048)}`,
    );
  }
  const root = parseGraph(graph.stdout);
  const skipped = skippedSources(graph.stderr).map((s) => ctx.rel(p, s));
  const tail: string[] = [];
  if (skipped.length) {
    tail.push(
      `skipped (dynamic, not allowed): ${skipped.join(", ")}${ctx.allowDynamicInventory ? "" : " (set ANSIBLE_MCP_ALLOW_DYNAMIC_INVENTORY=1 to allow; they run code)"}`,
    );
  }
  const footer = await ctx.footer(p);
  const red = new Redactor();

  const fallback = async (host?: string): Promise<string[]> => {
    const bases = new Map<string, string>();
    for (const s of sources) bases.set(isDir(s) ? s : dirname(s), "");
    bases.set(p.dir, "");
    const files = new ProjectFiles(p.dir);
    // The inventory-file vars are listed (and learnt by the redactor) BEFORE
    // the per-file view is rendered, so a secret from the inventory file that
    // is copied into a group_vars file under a plain key is still hidden.
    const env = { ANSIBLE_VARS_ENABLED: "none" };
    const r = await ctx.runSafe(
      p,
      "ansible-inventory",
      [host ? "--host" : "--list", ...(host ? [host] : []), ...iArgs],
      {
        env,
      },
    );
    let hv: Record<string, Record<string, unknown>> | null = null;
    if (r.code === 0) {
      try {
        const data = JSON.parse(r.stdout);
        hv = host ? { [host]: data } : (data?._meta?.hostvars ?? {});
        learnAll(red, hv!);
      } catch {
        hv = null; // fall through to the per-file view
      }
    }
    const fb = renderVarsFilesFallback(
      [...bases.keys()].map((b) => ({ base: b, label: files.rel(b) })),
      (abs) => files.rel(abs),
      red,
    );
    const out = [
      `degraded: group_vars/host_vars merged by Ansible are unavailable because ${fb.vaulted.join(", ") || "a vars file"} ${fb.vaulted.length === 1 ? "is a whole-file vault" : "are whole-file vaults"} (ansible-mcp never supplies vault secrets); showing per-file contents instead, without precedence.`,
    ];
    if (hv) {
      out.push("inventory-file vars only:");
      for (const [h, vars] of Object.entries(hv)) {
        if (varsMode === "names") out.push(`  ${h}: ${Object.keys(vars).sort().join(" ") || "(none)"}`);
        else {
          out.push(`  ${h}:`);
          out.push(...renderHostVars(vars, red, "    "));
        }
      }
    }
    out.push("group_vars / host_vars files:");
    out.push(...fb.lines);
    return out;
  };

  if (x.host) {
    const r = await ctx.runSafe(p, "ansible-inventory", ["--host", x.host, ...iArgs]);
    const groups = root ? groupsOf(root, x.host) : [];
    const head = `host ${x.host} (inventory ${label}, ${core}): groups ${groups.join(", ") || "(none)"}`;
    if (r.code !== 0 && hostMissing(r.stderr)) return `host '${x.host}' is not in this inventory`;
    let body: string[];
    if (r.code !== 0 && isVaultFailure(r.stderr)) {
      body = await fallback(x.host);
    } else if (r.code !== 0) {
      throw new Error(
        `ansible-inventory --host failed (exit ${r.code}):\n${redactText(r.stderr.trim()).slice(0, 2048)}`,
      );
    } else {
      const vars = JSON.parse(r.stdout || "{}") as Record<string, unknown>;
      learnAll(red, { [x.host]: vars });
      body =
        varsMode === "none"
          ? []
          : varsMode === "names"
            ? [`  ${Object.keys(vars).sort().join(" ")}`]
            : renderHostVars(vars, red);
      body.push(VARS_SCOPE_NOTE);
    }
    return [head, ...body, red.footer(), ...tail, footer].filter(Boolean).join("\n");
  }

  if (!root) return `inventory ${label}: no groups (empty inventory)`;
  const { hosts, groups } = graphStats(root);
  const lines = [`inventory ${label} (${core}): ${plural(hosts.size, "host")}, ${plural(groups.size, "group")}`];
  lines.push(...renderGraph(root, x.limit));
  if (varsMode !== "none") {
    const r = await ctx.runSafe(p, "ansible-inventory", ["--list", ...iArgs]);
    const hostList = [...hosts].slice(0, x.limit);
    if (r.code !== 0 && isVaultFailure(r.stderr)) {
      lines.push(...(await fallback()));
    } else if (r.code !== 0) {
      throw new Error(
        `ansible-inventory --list failed (exit ${r.code}):\n${redactText(r.stderr.trim()).slice(0, 2048)}`,
      );
    } else {
      const list = JSON.parse(r.stdout || "{}") as ListDoc;
      const hv = list._meta?.hostvars ?? {};
      learnAll(red, hv);
      lines.push(
        "vars (inventory-level only: group_vars/host_vars and inventory files; play, role and fact vars are not included):",
      );
      if (varsMode === "names") lines.push(...renderVarNames(list, hostList));
      else {
        for (const h of hostList) {
          lines.push(`  ${h}:`);
          lines.push(...renderHostVars(hv[h] ?? {}, red, "    "));
        }
      }
      if (hosts.size > hostList.length) lines.push(`  ... ${hosts.size - hostList.length} more hosts (raise limit)`);
    }
  }
  return [...lines, red.footer(), ...tail, footer].filter(Boolean).join("\n");
}

// --- ansible_playbook_structure -------------------------------------------------------------

export async function playbookStructure(
  ctx: AnsibleContext,
  x: {
    playbook: string;
    dir?: string;
    inventory?: string;
    limit?: string;
    tags?: string;
    skipTags?: string;
    maxTasks: number;
  },
): Promise<string> {
  refuseDash("limit", x.limit);
  refuseDash("tags", x.tags);
  refuseDash("skip_tags", x.skipTags);
  const p = await ctx.project(x.dir);
  const abs = assertRelative(ctx, p, x.playbook, "playbook");
  if (!isFile(abs)) return `${x.playbook} does not exist or is not a file in ${p.dir}`;
  const files = new ProjectFiles(p.dir);
  const rel = files.rel(abs);
  const hits = prescanPlaybook(files, rel);
  if (hits.length && !ctx.allowPlayLookups) return prescanRefusal(hits);
  ctx.runner.assertAvailable();
  const args: string[] = [];
  if (x.inventory) args.push("-i", await ctx.runner.toSide(assertRelative(ctx, p, x.inventory, "inventory")));
  if (x.limit) args.push("--limit", x.limit);
  if (x.tags) args.push("--tags", x.tags);
  if (x.skipTags) args.push("--skip-tags", x.skipTags);
  const core = await ctx.coreLabel();
  const pbArg = await ctx.runner.toSide(abs);
  const syntax = await ctx.runSafe(p, "ansible-playbook", ["--syntax-check", pbArg, ...args]);
  const msgs = parseStderrMessages(syntax.stderr);
  const plugins = localPluginFiles(files, rel);
  const pluginLine = plugins.length ? `local plugins loaded by Ansible: ${plugins.join(", ")}` : "";
  if (syntax.code !== 0) {
    const errs = msgs.filter((m) => m.kind === "ERROR");
    const lines = [`playbook ${rel} (${core}): syntax check FAILED`];
    for (const e of errs.length ? errs : [{ text: syntax.stderr.trim().split("\n")[0] ?? `exit ${syntax.code}` }]) {
      const o = "origin" in e && e.origin ? `${ctx.rel(p, e.origin.file)}:${e.origin.line}: ` : "";
      lines.push(`  ${o}${redactText(e.text)}`);
    }
    if (pluginLine) lines.push(pluginLine);
    return lines.join("\n");
  }
  const list = await ctx.runSafe(p, "ansible-playbook", [
    "--list-hosts",
    "--list-tasks",
    "--list-tags",
    pbArg,
    ...args,
  ]);
  if (list.code !== 0) {
    throw new Error(
      `ansible-playbook --list-tasks failed (exit ${list.code}):\n${redactText(list.stderr.trim()).slice(0, 2048)}`,
    );
  }
  const plays = parseListOutput(list.stdout);
  const cfg = await ctx.config(p);
  const rolesPaths = settingList(cfg, "DEFAULT_ROLES_PATH")
    .map((s) => ctx.runner.serverPathOf(s))
    .filter((s): s is string => !!s);
  const walk = walkPlaybooks(files, [rel], { rolesPaths });
  let docs: Awaited<ReturnType<AnsibleContext["docs"]>> | null = null;
  try {
    docs = await ctx.docs(p, docNamesFor(walk.tasks));
  } catch {
    docs = null;
  }
  const index = new Map<string, WalkTask[]>();
  for (const t of walk.tasks) {
    if (t.handler || t.name === undefined) continue;
    const k = `${t.play ?? 0}|${t.role ?? ""}|${t.name}`;
    index.set(k, [...(index.get(k) ?? []), t]);
  }
  const allHosts = new Set<string>();
  let nTasks = 0;
  for (const pl of plays) {
    for (const h of pl.hosts ?? []) allHosts.add(h);
    nTasks += pl.tasks.length;
  }
  const lines = [
    `playbook ${rel} (${core}): syntax ok, ${plural(plays.length, "play")}, ${plural(nTasks, "task")}, hosts matched ${allHosts.size}`,
  ];
  let shown = 0;
  const allTags = new Set<string>();
  for (const pl of plays) {
    const info = walk.plays[pl.index - 1];
    const hostList = pl.hosts ?? [];
    const hostsText =
      pl.hostCount === null
        ? ""
        : ` (${pl.hostCount}${hostList.length ? `: ${hostList.slice(0, 8).join(", ")}${hostList.length > 8 ? ", ..." : ""}` : ""})`;
    const roles = info?.roles.length
      ? ` roles: ${info.roles.join(", ")}${info.deps.length ? ` (+ dependenc${info.deps.length === 1 ? "y" : "ies"} ${[...new Set(info.deps)].join(", ")})` : ""}`
      : "";
    lines.push(`play ${pl.index} '${pl.name}' hosts=${pl.pattern}${hostsText} tags [${pl.tags.join(", ")}]${roles}`);
    for (const tg of pl.taskTags) allTags.add(tg);
    for (const t of pl.tasks) {
      if (shown >= x.maxTasks) break;
      shown++;
      const name = `${t.role ? `${t.role} : ` : ""}${t.name}`;
      const tags = t.tags.length ? ` [${t.tags.join(", ")}]` : "";
      if (/^Validating arguments against arg spec /.test(t.name)) {
        lines.push(`  ${name}${tags} (inserted by Ansible)`);
        continue;
      }
      const cands = index.get(`${pl.index}|${t.role ?? ""}|${t.name}`) ?? [];
      let ann = "";
      if (cands.length === 1) {
        const w = cands[0]!;
        const res = docs ? resolveTaskDoc(w, docs) : null;
        const mod = res?.kind === "doc" ? res.doc.fqcn : (w.action ?? "?");
        ann = ` ${mod} ${w.file}:${w.line}`;
        if (w.include && /include/.test(w.include.kind)) {
          ann += w.include.templated ? " [dynamic, templated name]" : ` [dynamic: ${w.include.target} not expanded]`;
        }
      }
      lines.push(`  ${name}${tags}${ann}`);
    }
  }
  if (nTasks > shown) lines.push(`... ${nTasks - shown} more tasks (raise max_tasks)`);
  lines.push(`tags: ${[...allTags].sort().join(", ") || "(none)"}`);
  const deps = new Map<string, string>();
  for (const m of [...msgs, ...parseStderrMessages(list.stderr)]) {
    if (m.kind !== "DEPRECATION WARNING" || !m.origin || m.origin.file.startsWith("<")) continue;
    const loc = `${ctx.rel(p, m.origin.file)}:${m.origin.line}`;
    deps.set(`${loc} ${m.text}`, `  ${loc} ${redactText(m.text)}`);
  }
  if (deps.size) {
    lines.push(`deprecations seen while parsing (${deps.size}):`);
    lines.push(...deps.values());
  }
  if (walk.notFollowed.length) lines.push(`not followed statically: ${walk.notFollowed.join("; ")}`);
  if (pluginLine) lines.push(pluginLine);
  const footer = await ctx.footer(p);
  if (footer) lines.push(footer);
  return lines.join("\n");
}

// --- ansible_config ------------------------------------------------------------------------

export async function config(
  ctx: AnsibleContext,
  x: { dir?: string; all: boolean; filter?: string; limit: number },
): Promise<string> {
  ctx.runner.assertAvailable();
  const p = await ctx.project(x.dir);
  const [dump, ver, localTmp] = await Promise.all([ctx.config(p), ctx.version(), ctx.localTmp()]);
  return renderConfig(dump, {
    hiddenLocalTmp: localTmp,
    dirLabel: p.dir,
    coreVersion: `${ver.core}${ctx.runner.label()}`,
    all: x.all,
    ...(x.filter ? { filter: x.filter } : {}),
    limit: x.limit,
    ...(p.drvfsNote ? { drvfsNote: p.drvfsNote } : {}),
    display: (s) => relativeTo(s, p.sideDir) ?? ctx.runner.displaySide(s, false),
  });
}

// --- ansible_collections --------------------------------------------------------------------

export async function collections(
  ctx: AnsibleContext,
  x: { dir?: string; requirements?: string; includeExtras: boolean },
): Promise<string> {
  ctx.runner.assertAvailable();
  const p = await ctx.project(x.dir);
  const files = new ProjectFiles(p.dir);
  let reqRels: string[];
  if (x.requirements) {
    const abs = assertRelative(ctx, p, x.requirements, "requirements");
    if (!isFile(abs)) return `${x.requirements} does not exist in ${p.dir}`;
    reqRels = [files.rel(abs)];
  } else {
    reqRels = [
      "requirements.yml",
      "requirements.yaml",
      "collections/requirements.yml",
      "roles/requirements.yml",
    ].filter((f) => isFile(join(p.dir, f)));
  }
  const [cfg, list, roles] = await Promise.all([
    ctx.config(p),
    ctx.runSafe(p, "ansible-galaxy", ["collection", "list", "--format", "json"]),
    ctx.runSafe(p, "ansible-galaxy", ["role", "list"]),
  ]);
  if (list.code !== 0) {
    throw new Error(`ansible-galaxy collection list failed (exit ${list.code}):\n${list.stderr.trim().slice(0, 2048)}`);
  }
  const collectionsPaths = settingList(cfg, "COLLECTIONS_PATHS");
  return renderCollections({
    reqFiles: reqRels.map((f) => ({ file: f, reqs: parseRequirements(files.read(join(p.dir, f))?.root, f) })),
    installed: byCollection(parseCollectionList(list.stdout), collectionsPaths),
    roles: roles.code === 0 ? parseRoleList(roles.stdout) : [],
    collectionsPaths,
    includeExtras: x.includeExtras,
    display: (s) => ctx.runner.displaySide(s),
  });
}

// --- ansible_lint_summary ----------------------------------------------------------------------

const PROFILES = ["min", "basic", "moderate", "safety", "shared", "production"];

export async function lintSummary(
  ctx: AnsibleContext,
  x: { dir?: string; paths?: string[]; profile?: string; maxLocations: number },
): Promise<string> {
  if (x.profile && !PROFILES.includes(x.profile)) return `profile must be one of ${PROFILES.join(", ")}`;
  const p = await ctx.project(x.dir);
  const files = new ProjectFiles(p.dir);
  const targetAbs = (x.paths ?? []).map((rel) => assertRelative(ctx, p, rel, "paths"));
  // R1: lint runs syntax-check internally, so the same pre-scan applies. A
  // directory target (or no paths: the whole project) is linted all the way
  // down, so every playbook-like YAML file under it is pre-scanned.
  const hits = prescanLintTargets(files, targetAbs.length ? targetAbs : [p.dir]);
  if (hits.length && !ctx.allowPlayLookups) return prescanRefusal(hits);
  ctx.runner.assertAvailable();
  // Inside dir: relative (lint runs with cwd = dir). Outside: the Ansible-side path (WSL translation).
  const targets: string[] = [];
  for (const a of targetAbs) {
    const rel = files.rel(a);
    const target = rel === a.replace(/\\/g, "/") ? await ctx.runner.toSide(a) : rel;
    // A positional that reads as an option (`--fix` writes files) is never passed.
    refuseDash("paths", target);
    targets.push(target);
  }
  // `--` ends ansible-lint's (argparse) options, so no target can be read as one.
  const args = [
    "--offline",
    "-f",
    "codeclimate",
    ...(x.profile ? ["--profile", x.profile] : []),
    ...(targets.length ? ["--", ...targets] : []),
  ];
  const [r, v] = await Promise.all([
    ctx.runSafe(p, "ansible-lint", args),
    ctx
      .quietEnv()
      .then((env) => ctx.runner.run("ansible-lint", ["--version", "--offline"], { env }))
      .catch(() => null),
  ]);
  if (r.code !== 0 && r.code !== 2) {
    throw new Error(`ansible-lint failed (exit ${r.code}):\n${redactText(r.stderr.trim()).slice(-2048)}`);
  }
  const version = v ? (/ansible-lint\s+([\d.]+)/.exec(stripAnsi(v.stdout))?.[1] ?? "?") : "?";
  return renderLint(version, parseCodeclimate(r.stdout), r.stderr, x.maxLocations, x.profile);
}

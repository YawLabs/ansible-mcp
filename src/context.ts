import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { classifyDocStderr, type DocStderr, type PluginDoc, parseDocJson, type Tombstone } from "./ansibleDoc.js";
import { type ConfigDump, configFile, parseConfigDump, safetyFooter, settingList } from "./config.js";
import {
  AnsibleRunner,
  COLOR_ENV,
  defaultLocalCache,
  type ExecConfig,
  type RunOptions,
  type RunResult,
  readExecConfig,
  type Spawner,
  safetyEnv,
} from "./exec.js";
import { relativeTo } from "./paths.js";

/**
 * Per-server state: the runner, per-dir preparation (Ansible-side path, the
 * DrvFs ANSIBLE_CONFIG rule), the config dump, the core version, and the
 * ansible-doc cache keyed by an installed-content fingerprint (design.md 7.12).
 */

export interface ContextOptions {
  defaultDir?: string;
  exec?: ExecConfig;
  spawner?: Spawner;
  /** Server-side cache root (native mode Ansible-side cache too). */
  cacheDir?: string;
  /** Ansible-side cache root in prefix mode. */
  remoteCache?: string;
  allowDynamicInventory?: boolean;
  allowPlayLookups?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface Project {
  /** Server-side absolute path. */
  dir: string;
  /** Ansible-side path. */
  sideDir: string;
  /** Extra env for every Ansible child in this dir (ANSIBLE_CONFIG under the DrvFs rule). */
  env: Record<string, string>;
  /** Set when the server set ANSIBLE_CONFIG itself. */
  drvfsNote?: string;
}

export const DRVFS_NOTE = "set via ANSIBLE_CONFIG: DrvFs reports Windows folders as world-writable";

export interface DocResult {
  docs: Map<string, PluginDoc>;
  missing: string[];
  tombstones: Tombstone[];
  deprecations: DocStderr["deprecations"];
}

const FINGERPRINT_TTL_MS = 30_000;
const DOC_BATCH = 50;

export class AnsibleContext {
  readonly runner: AnsibleRunner;
  readonly defaultDir: string;
  readonly allowDynamicInventory: boolean;
  readonly allowPlayLookups: boolean;
  private readonly configCache = new Map<string, { key: string; dump: ConfigDump }>();
  private versionCache: Promise<VersionInfo> | null = null;
  private readonly fingerprints = new Map<string, { at: number; fp: Promise<string> }>();
  /** Per-name doc results; `deprecations` replays the batch's warnings naming that entry on a hit. */
  private readonly docCache = new Map<
    string,
    { kind: "doc" | "missing"; doc?: PluginDoc; deprecations: DocStderr["deprecations"] } | Tombstone
  >();
  private readonly listCache = new Map<string, Record<string, string>>();
  /** Serializes ansible_upgrade_impact calls in this process. */
  upgradeLock: Promise<unknown> = Promise.resolve();

  constructor(opts: ContextOptions = {}) {
    const env = opts.env ?? process.env;
    this.runner = new AnsibleRunner(
      opts.exec ?? readExecConfig(env),
      opts.spawner,
      opts.cacheDir ?? defaultLocalCache(env),
      opts.remoteCache ?? (env.ANSIBLE_MCP_REMOTE_CACHE || null),
    );
    this.defaultDir = opts.defaultDir ?? (env.ANSIBLE_MCP_DIR || process.cwd());
    this.allowDynamicInventory = opts.allowDynamicInventory ?? env.ANSIBLE_MCP_ALLOW_DYNAMIC_INVENTORY === "1";
    this.allowPlayLookups = opts.allowPlayLookups ?? env.ANSIBLE_MCP_ALLOW_PLAY_LOOKUPS === "1";
  }

  /** Resolve `dir` on the server side (UNC refused, except a WSL path of our distro). */
  resolveDir(dir?: string): string {
    const raw = dir || this.defaultDir;
    this.runner.assertLocal(raw);
    const abs = /^[\\/]{2}/.test(raw) ? raw : resolve(raw);
    this.runner.assertLocal(abs);
    let ok = false;
    try {
      ok = statSync(abs).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`${abs} does not exist or is not a directory. Pass \`dir\` as an Ansible project path.`);
    return abs;
  }

  /** Resolve and prepare a project dir for spawning (Ansible-side path, DrvFs rule). */
  async project(dir?: string): Promise<Project> {
    const abs = this.resolveDir(dir);
    if (!this.runner.available()) return { dir: abs, sideDir: abs, env: {} };
    const sideDir = await this.runner.toSide(abs);
    const p: Project = { dir: abs, sideDir, env: {} };
    if (
      this.runner.cfg.style === "wsl" &&
      existsSync(`${abs}/ansible.cfg`) &&
      !this.runner.cfg.passEnv.includes("ANSIBLE_CONFIG") &&
      (await this.runner.isOnDrvFs(sideDir))
    ) {
      p.env.ANSIBLE_CONFIG = `${sideDir}/ansible.cfg`;
      p.drvfsNote = DRVFS_NOTE;
    }
    return p;
  }

  /** Relative display of an Ansible-side path under the project, else the side display. */
  rel(p: Project, sidePath: string): string {
    return relativeTo(sidePath, p.sideDir) ?? this.runner.displaySide(sidePath);
  }

  /** The env + unset for a "safe" Ansible child in this project. */
  async safety(p: Project, extra: Record<string, string> = {}): Promise<Pick<RunOptions, "env" | "unset" | "cwd">> {
    const s = await this.probeEnv();
    return { cwd: p.dir, env: { ...s.env, ...p.env, ...extra }, unset: s.unset };
  }

  /**
   * The safety env without a project, for the `--version` probes (`ansible`,
   * `ansible-lint`, and the per-binary probes in ansible_project_info). Only
   * `ansible-config dump` runs without it: a probe reads the effective config
   * too (an `ANSIBLE_CONFIG` the user forwards, or an ansible.cfg in the cwd),
   * so a configured vault_password_file script must be replaced there as well.
   */
  async probeEnv(): Promise<{ env: Record<string, string>; unset: string[] }> {
    const cacheRoot = await this.runner.sideCacheRoot();
    const vaultFile = await this.runner.vaultNullFile();
    return safetyEnv({
      vaultFile,
      cacheRoot,
      allowDynamicInventory: this.allowDynamicInventory,
      join: (a, b) => this.runner.sideJoin(a, b),
    });
  }

  /** Run an Ansible tool in the project with the safety environment. */
  async runSafe(p: Project, tool: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const s = await this.safety(p, opts.env);
    return this.runner.run(tool, args, { ...opts, ...s, unset: [...(s.unset ?? []), ...(opts.unset ?? [])] });
  }

  /**
   * The full config dump for a project, run WITHOUT the safety env (it executes
   * no project code, F11) so it reports the user's real settings. Cached per
   * (dir, ansible.cfg mtime, env).
   */
  async config(p: Project): Promise<ConfigDump> {
    let mtime = 0;
    try {
      mtime = statSync(`${p.dir}/ansible.cfg`).mtimeMs;
    } catch {
      mtime = 0;
    }
    const key = `${mtime}|${JSON.stringify(p.env)}`;
    const hit = this.configCache.get(p.dir);
    if (hit && hit.key === key) return hit.dump;
    const r = await this.runner.run("ansible-config", ["dump", "--format", "json"], {
      cwd: p.dir,
      env: { ...(await this.quietEnv()), ...p.env },
    });
    if (r.code !== 0) {
      throw new Error(`ansible-config dump failed (exit ${r.code}):\n${r.stderr.trim().slice(0, 2048)}`);
    }
    const dump = parseConfigDump(r.stdout);
    this.configCache.set(p.dir, { key, dump });
    return dump;
  }

  /** `safety: ...` footer for this project's config, or "". */
  async footer(p: Project): Promise<string> {
    try {
      return safetyFooter(await this.config(p), this.allowDynamicInventory);
    } catch {
      return "";
    }
  }

  /**
   * Env for the one command that runs WITHOUT the safety env (`ansible-config
   * dump`): colours off, and local_tmp in the server's cache,
   * because resolving the config creates a dir under local_tmp (F15) and the
   * server never writes into ~/.ansible. Nothing else, so the dump still reports
   * the user's vault and inventory settings.
   */
  async quietEnv(): Promise<Record<string, string>> {
    return { ...COLOR_ENV, ANSIBLE_LOCAL_TEMP: await this.localTmp() };
  }

  /** The local_tmp this server gives Ansible (hidden from ansible_config output). */
  async localTmp(): Promise<string> {
    return this.runner.sideJoin(await this.runner.sideCacheRoot(), "local-tmp");
  }

  /** `ansible --version`, once per process, under the safety env. */
  version(): Promise<VersionInfo> {
    if (!this.versionCache) {
      const pending = this.probeEnv()
        .then((s) => this.runner.run("ansible", ["--version"], s))
        .then((r) => {
          if (r.code !== 0)
            throw new Error(`ansible --version failed (exit ${r.code}): ${r.stderr.trim().slice(0, 500)}`);
          return parseVersionOutput(r.stdout);
        });
      pending.catch(() => {
        this.versionCache = null;
      });
      this.versionCache = pending;
    }
    return this.versionCache;
  }

  /** Header suffix: `ansible-core 2.21.5 via wsl.exe -d Ubuntu --exec`. */
  async coreLabel(): Promise<string> {
    return `ansible-core ${(await this.version()).core}${this.runner.label()}`;
  }

  /**
   * sha256 of (exec target, core version, COLLECTIONS_PATHS, collection list),
   * recomputed at most every 30 s per project, so installing a collection
   * shows up within 30 s.
   */
  async fingerprint(p: Project): Promise<string> {
    const hit = this.fingerprints.get(p.dir);
    if (hit && Date.now() - hit.at < FINGERPRINT_TTL_MS) return hit.fp;
    const fp = (async () => {
      const [v, cfg, list] = await Promise.all([
        this.version(),
        this.config(p),
        this.runSafe(p, "ansible-galaxy", ["collection", "list", "--format", "json"]),
      ]);
      return createHash("sha256")
        .update(this.runner.targetId())
        .update(v.core)
        .update(JSON.stringify(settingList(cfg, "COLLECTIONS_PATHS")))
        .update(configFile(cfg) ?? "")
        .update(list.stdout)
        .digest("hex")
        .slice(0, 16);
    })();
    fp.catch(() => this.fingerprints.delete(p.dir));
    this.fingerprints.set(p.dir, { at: Date.now(), fp });
    return fp;
  }

  /**
   * `ansible-doc --json -t <type> <names...>`, batched (50 per call), with the
   * tombstone retry (F2: one tombstone fails the whole batch, so it is recorded
   * and the batch re-run without it). `collectionsPath` overrides
   * ANSIBLE_COLLECTIONS_PATH (upgrade targets); those results are not cached.
   * A name starting with `-` is never a plugin name: it is reported missing and
   * never reaches argv (task keys are user data; `-M x` would be an option), and
   * the names follow `--` besides.
   */
  async docs(
    p: Project,
    names: string[],
    opts: { type?: string; collectionsPath?: string; extraArgs?: string[] } = {},
  ): Promise<DocResult> {
    const type = opts.type ?? "module";
    const result: DocResult = { docs: new Map(), missing: [], tombstones: [], deprecations: [] };
    const unique = [...new Set(names)];
    const cacheable = !opts.collectionsPath && !opts.extraArgs;
    const fp = cacheable ? await this.fingerprint(p) : "";
    const todo: string[] = [];
    for (const n of unique) {
      if (n.startsWith("-")) {
        result.missing.push(n);
        continue;
      }
      const c = cacheable ? this.docCache.get(`${fp}|${type}|${n}`) : undefined;
      if (!c) todo.push(n);
      else if ("kind" in c) {
        if (c.kind === "doc" && c.doc) result.docs.set(n, c.doc);
        else result.missing.push(n);
        result.deprecations.push(...c.deprecations);
      } else result.tombstones.push(c);
    }
    const env: Record<string, string> = {};
    if (opts.collectionsPath) env.ANSIBLE_COLLECTIONS_PATH = opts.collectionsPath;
    for (let i = 0; i < todo.length; i += DOC_BATCH) {
      let batch = todo.slice(i, i + DOC_BATCH);
      for (let attempt = 0; batch.length > 0 && attempt <= batch.length; attempt++) {
        const r = await this.runSafe(
          p,
          "ansible-doc",
          ["--json", "-t", type, ...(opts.extraArgs ?? []), "--", ...batch],
          {
            env,
          },
        );
        const st = classifyDocStderr(r.stderr);
        if (r.code !== 0) {
          const tomb = st.tombstones.filter((t) => batch.includes(t.name));
          if (tomb.length === 0) {
            throw new Error(`ansible-doc failed (exit ${r.code}):\n${r.stderr.trim().slice(0, 2048)}`);
          }
          for (const t of tomb) {
            result.tombstones.push(t);
            if (cacheable) this.docCache.set(`${fp}|${type}|${t.name}`, t);
          }
          batch = batch.filter((n) => !tomb.some((t) => t.name === n));
          continue;
        }
        const docs = parseDocJson(r.stdout);
        for (const n of batch) {
          const d = docs.get(n);
          if (d) result.docs.set(n, d);
          else result.missing.push(n);
          if (cacheable) {
            const deprecations = st.deprecations.filter((x) => x.name === n);
            this.docCache.set(
              `${fp}|${type}|${n}`,
              d ? { kind: "doc", doc: d, deprecations } : { kind: "missing", deprecations },
            );
          }
        }
        result.deprecations.push(...st.deprecations);
        break;
      }
    }
    return result;
  }

  /** `ansible-doc -l -j -t <type> [collection]` -> {fqcn: short description}, cached per fingerprint. */
  async listPlugins(p: Project, type: string, collection?: string): Promise<Record<string, string>> {
    const fp = await this.fingerprint(p);
    const key = `${fp}|${type}|${collection ?? ""}`;
    const hit = this.listCache.get(key);
    if (hit) return hit;
    const r = await this.runSafe(p, "ansible-doc", ["-l", "-j", "-t", type, ...(collection ? [collection] : [])]);
    if (r.code !== 0) throw new Error(`ansible-doc -l failed (exit ${r.code}):\n${r.stderr.trim().slice(0, 2048)}`);
    let data: Record<string, string> = {};
    try {
      data = r.stdout.trim() ? JSON.parse(r.stdout) : {};
    } catch {
      throw new Error("ansible-doc -l -j did not return JSON.");
    }
    this.listCache.set(key, data);
    return data;
  }
}

export interface VersionInfo {
  core: string;
  python: string;
  jinja: string;
  configFile: string | null;
  collectionLocation: string;
}

/** `ansible --version`: `ansible [core X]` then `  key = value` lines. */
export function parseVersionOutput(text: string): VersionInfo {
  const core = /ansible \[core ([^\]]+)\]/.exec(text)?.[1] ?? /ansible ([\d.]+)/.exec(text)?.[1] ?? "?";
  const kv = (k: string) => new RegExp(`^\\s*${k} = (.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
  const cfg = kv("config file");
  return {
    core,
    python: kv("python version").split(" ")[0] ?? "",
    jinja: kv("jinja version"),
    configFile: cfg && cfg !== "None" ? cfg : null,
    collectionLocation: kv("ansible collection location"),
  };
}

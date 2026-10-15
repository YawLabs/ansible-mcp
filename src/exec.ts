import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, posix } from "node:path";
import { assertLocalPath, mountRootFromWslpath, PlainAnswer, parseWslUnc, winToWsl, wslToWin } from "./paths.js";

/**
 * Running Ansible (design.md sections 3 and 4.2).
 *
 * Ansible does not run on Windows. The server reaches it natively (macOS,
 * Linux) or through a command prefix, normally `wsl.exe -d <distro> --exec`.
 * Every spawn is an argv array with `shell: false`; with a prefix the argv is
 *
 *   [...prefix (with `--cd <dir>` spliced before --exec), "env", -u X..., K=V..., <bin>, ...args]
 *
 * because `wsl.exe -- ...` re-parses the command line with bash (F20) and
 * Windows environment variables do not cross into WSL (F21).
 */

export const NATIVE_WINDOWS_MESSAGE =
  "Ansible cannot run natively on Windows. Set ANSIBLE_MCP_COMMAND_PREFIX, e.g. " +
  '["wsl.exe","-d","Ubuntu","--exec"], and ANSIBLE_MCP_BIN_DIR to the venv bin dir inside WSL.';

export const DEFAULT_TIMEOUT_MS = 120_000;
/** setTimeout clamps anything above 2^31-1 ms to 1 ms. */
export const MAX_TIMEOUT_MS = 2_147_483_647;
const STDERR_CAP = 64 * 1024;

export type PathStyle = "native" | "wsl" | "generic";

export interface ExecConfig {
  prefix: string[] | null;
  binDir: string | null;
  style: PathStyle;
  passEnv: string[];
  timeoutMs: number;
  platform: NodeJS.Platform;
}

/** Parse ANSIBLE_MCP_COMMAND_PREFIX: a JSON array, or a whitespace-separated string. */
export function parsePrefix(raw: string | undefined): string[] | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  if (t.startsWith("[")) {
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      throw new Error('ANSIBLE_MCP_COMMAND_PREFIX is not valid JSON; use an array such as ["wsl.exe","--exec"].');
    }
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x.length > 0)) {
      throw new Error("ANSIBLE_MCP_COMMAND_PREFIX must be a non-empty JSON array of strings.");
    }
    return v as string[];
  }
  return t.split(/\s+/);
}

function basenameAny(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function detectStyle(prefix: string[] | null, raw: string | undefined): PathStyle {
  const s = (raw ?? "auto").trim().toLowerCase();
  if (!prefix) return "native";
  if (s === "wsl") return "wsl";
  if (s === "native") return "generic";
  return /^wsl(\.exe)?$/i.test(basenameAny(prefix[0]!)) ? "wsl" : "generic";
}

/** A wsl prefix must run the command with --exec (or -e): `--` routes it through bash (F20). */
export function validateWslPrefix(prefix: string[]): void {
  if (prefix[prefix.length - 1] === "--" || !prefix.some((a) => a === "--exec" || a === "-e")) {
    throw new Error(
      "ANSIBLE_MCP_COMMAND_PREFIX must use wsl.exe --exec (or -e), not --: with -- WSL re-parses the arguments with a shell.",
    );
  }
}

export function readExecConfig(env: NodeJS.ProcessEnv = process.env, platform = process.platform): ExecConfig {
  const prefix = parsePrefix(env.ANSIBLE_MCP_COMMAND_PREFIX);
  const style = detectStyle(prefix, env.ANSIBLE_MCP_PATH_STYLE);
  if (prefix && style === "wsl") validateWslPrefix(prefix);
  const n = Number(env.ANSIBLE_MCP_TIMEOUT_MS);
  return {
    prefix,
    binDir: env.ANSIBLE_MCP_BIN_DIR?.trim() || null,
    style,
    passEnv: (env.ANSIBLE_MCP_PASS_ENV ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    timeoutMs: Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
    platform,
  };
}

/** The `-d` / `--distribution` value of a wsl prefix, if any. */
export function prefixDistro(prefix: string[] | null): string | null {
  if (!prefix) return null;
  for (let i = 0; i < prefix.length - 1; i++) {
    if (prefix[i] === "-d" || prefix[i] === "--distribution") return prefix[i + 1]!;
  }
  return null;
}

export interface PrefixedArgvInput {
  prefix: string[];
  cwd?: string;
  env: Record<string, string>;
  unset: string[];
  bin: string;
  args: string[];
  style: "wsl" | "generic";
}

/** The full argv for a prefixed spawn (design.md 3.2). */
export function buildPrefixedArgv(i: PrefixedArgvInput): string[] {
  const envPart = [
    "env",
    ...(i.style === "generic" && i.cwd ? ["-C", i.cwd] : []),
    ...i.unset.flatMap((n) => ["-u", n]),
    ...Object.entries(i.env).map(([k, v]) => `${k}=${v}`),
  ];
  let pre = [...i.prefix];
  if (i.style === "wsl" && i.cwd) {
    const at = pre.findIndex((a) => a === "--exec" || a === "-e");
    pre = [...pre.slice(0, at), "--cd", i.cwd, ...pre.slice(at)];
  }
  return [...pre, ...envPart, i.bin, ...i.args];
}

/** wsl.exe's own errors come as UTF-16LE on stdout (F23). */
export function looksUtf16(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const n = Math.min(buf.length, 64);
  let zeros = 0;
  for (let i = 1; i < n; i += 2) if (buf[i] === 0) zeros++;
  return zeros >= Math.floor(n / 4);
}

export function decodeWslError(stdout: Buffer, distro: string | null): string {
  const text = stdout.toString("utf16le").replace(/^﻿/, "").replace(/\0/g, "").trim();
  if (/WSL_E_DISTRO_NOT_FOUND/.test(text))
    return `WSL distro '${distro ?? "(default)"}' not found (wsl.exe -l lists them).`;
  return `wsl.exe failed: ${text.split(/\r?\n/)[0] ?? text}`;
}

/** `execvpe(<path>) failed` (wsl.exe) or `env: '<path>': No such file or directory` (GNU env). */
export function missingBinaryPath(stderr: string): string | null {
  const m =
    /execvpe\(([^)]+)\) failed: No such file or directory/.exec(stderr) ??
    /^env: [‘'`]?([^’'`:\n]+)[’'`]?: No such file or directory/m.exec(stderr);
  return m ? m[1]! : null;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Server-side working directory (translated for the Ansible side). */
  cwd?: string;
  /** Variables for the Ansible-side process. */
  env?: Record<string, string>;
  /** Variables to remove on the Ansible side. */
  unset?: string[];
  timeoutMs?: number;
  /** Text written to stdin (stdin is /dev/null otherwise). */
  input?: string;
}

export interface SpawnResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Low-level process runner; tests inject one that replays fixture output. */
export type Spawner = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; input?: string },
) => Promise<SpawnResult>;

export class TimeoutError extends Error {
  constructor(
    message: string,
    readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "TimeoutError";
  }
}

export const nodeSpawner: Spawner = (cmd, args, { cwd, env, timeoutMs, input }) =>
  new Promise((resolvePromise, reject) => {
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
      reject(
        new Error(
          `could not run '${cmd}': .cmd/.bat shims cannot be spawned without a shell, and this server never uses one.`,
        ),
      );
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (e) {
      reject(e);
      return;
    }
    const out: Buffer[] = [];
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => {
      if (err.length < STDERR_CAP) err += c.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new TimeoutError(`${basenameAny(cmd)} did not finish within ${timeoutMs} ms and was killed.`, timeoutMs),
        );
      } else {
        resolvePromise({ code, stdout: Buffer.concat(out), stderr: err });
      }
    });
    if (input !== undefined) child.stdin?.end(input);
  });

export function defaultLocalCache(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANSIBLE_MCP_CACHE || join(homedir(), ".cache", "ansible-mcp");
}

/**
 * One Ansible "control node" as this server reaches it: native, or behind a
 * prefix. Knows how to spawn, how to translate paths, and where its caches live.
 */
export class AnsibleRunner {
  private mountRoot: string | null = null;
  private sideEnvCache: Promise<Record<string, string>> | null = null;
  private vaultFile: Promise<string> | null = null;

  constructor(
    readonly cfg: ExecConfig,
    private readonly spawner: Spawner = nodeSpawner,
    /** Server-side cache root for native mode (vault-null file, upgrade targets). */
    readonly localCache: string = defaultLocalCache(),
    /** Ansible-side cache root override in prefix mode (ANSIBLE_MCP_REMOTE_CACHE). */
    private readonly remoteCacheOverride: string | null = null,
  ) {}

  get prefixed(): boolean {
    return this.cfg.prefix !== null;
  }

  /** False on native Windows: nothing Ansible-backed can run. */
  available(): boolean {
    return this.prefixed || this.cfg.platform !== "win32";
  }

  assertAvailable(): void {
    if (!this.available()) throw new PlainAnswer(NATIVE_WINDOWS_MESSAGE);
  }

  /** ` via wsl.exe -d Ubuntu --exec` for headers, or "". */
  label(): string {
    return this.cfg.prefix ? ` via ${this.cfg.prefix.join(" ")}` : "";
  }

  /** Stable id of this exec target, for cache keys. */
  targetId(): string {
    return JSON.stringify([this.cfg.prefix, this.cfg.binDir]);
  }

  distro(): string | null {
    return this.cfg.style === "wsl" ? prefixDistro(this.cfg.prefix) : null;
  }

  /** Check a server-side path before any fs call (UNC refused, WSL UNC of our distro allowed). */
  assertLocal(p: string): void {
    assertLocalPath(p, this.cfg.style === "wsl" ? this.distro() : null);
  }

  /** Ansible-side path join. */
  sideJoin(...parts: string[]): string {
    return this.prefixed ? posix.join(...parts) : join(...parts);
  }

  binPath(tool: string): string {
    if (!this.cfg.binDir) return tool;
    return this.sideJoin(this.cfg.binDir, tool);
  }

  /** Learn the WSL mount root once (`wslpath -a -u C:\` -> `/mnt/c/` -> `/mnt/`). */
  async getMountRoot(): Promise<string> {
    if (this.mountRoot) return this.mountRoot;
    const r = await this.raw("wslpath", ["-a", "-u", "C:\\"], {});
    this.mountRoot = r.code === 0 ? mountRootFromWslpath(r.stdout) : "/mnt/";
    return this.mountRoot;
  }

  /** Server-side path -> Ansible-side path. */
  async toSide(p: string): Promise<string> {
    if (this.cfg.style !== "wsl") return p;
    const unc = parseWslUnc(p);
    if (unc) return `/${unc.rest}`;
    if (p.startsWith("/")) return p;
    const t = winToWsl(p, await this.getMountRoot());
    if (!t) throw new Error(`${p} cannot be translated to a WSL path.`);
    return t;
  }

  /** True when an Ansible-side path is on the Windows drive mount (DrvFs, F22). */
  async isOnDrvFs(sidePath: string): Promise<boolean> {
    if (this.cfg.style !== "wsl") return false;
    return sidePath.startsWith(await this.getMountRoot());
  }

  /** Ansible-side path -> something the agent can use: `X:\...`, or the Linux path labelled "(inside WSL)". */
  displaySide(p: string, label = true): string {
    if (this.cfg.style !== "wsl") return p;
    const win = this.mountRoot ? wslToWin(p, this.mountRoot) : null;
    return win ?? (label ? `${p} (inside WSL)` : p);
  }

  /** Ansible-side path -> a path this process can read with fs, or null. */
  serverPathOf(p: string): string | null {
    if (!this.prefixed) return p;
    if (this.cfg.style !== "wsl") return null;
    const win = this.mountRoot ? wslToWin(p, this.mountRoot) : null;
    if (win) return win;
    const d = this.distro();
    return d ? `\\\\wsl.localhost\\${d}${p.replace(/\//g, "\\")}` : null;
  }

  /** The Ansible side's environment (prefix mode; learned once per process). */
  sideEnv(): Promise<Record<string, string>> {
    if (!this.prefixed) return Promise.resolve(process.env as Record<string, string>);
    this.sideEnvCache ??= this.raw("env", [], {}).then((r) => {
      const out: Record<string, string> = {};
      for (const line of r.stdout.split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
      }
      return out;
    });
    return this.sideEnvCache;
  }

  /** Ansible-side cache root: ANSIBLE_MCP_REMOTE_CACHE, else $HOME/.cache/ansible-mcp (never /tmp, F24). */
  async sideCacheRoot(): Promise<string> {
    if (!this.prefixed) return this.localCache;
    if (this.remoteCacheOverride) return this.remoteCacheOverride;
    const home = (await this.sideEnv()).HOME || "/tmp";
    return posix.join(home, ".cache", "ansible-mcp");
  }

  /**
   * A server-owned file holding a random password, mode 0600 (F7): it replaces
   * any configured vault_password_file / vault_identity_list script, so the
   * script never runs, and it decrypts nothing.
   */
  vaultNullFile(): Promise<string> {
    if (!this.vaultFile) {
      const p = (async () => {
        // One file per cache, reused across server processes (any content decrypts
        // nothing, so a concurrent rewrite is harmless); a per-process name would
        // leave one file behind per server start.
        const root = await this.sideCacheRoot();
        const f = this.sideJoin(root, "vault-null");
        if (((await this.sideReadFile(f)) ?? "").trim().length >= 32) return f;
        await this.sideMkdirp(root);
        await this.sideWriteFile(f, `${randomBytes(32).toString("hex")}\n`);
        return f;
      })();
      p.catch(() => {
        this.vaultFile = null;
      });
      this.vaultFile = p;
    }
    return this.vaultFile;
  }

  /**
   * Run an Ansible executable (`ansible-doc`, ...). `env` and `unset` apply to
   * the Ansible-side process only. Rejects when the process could not start,
   * was not found, or timed out; a non-zero exit is a result.
   */
  async run(tool: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    this.assertAvailable();
    return this.exec(this.binPath(tool), tool, args, opts, true);
  }

  /** Plumbing on the Ansible side (`wslpath`, `env`, `cat`, `mkdir`, `mv`). Never joined with BIN_DIR. */
  async raw(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
    this.assertAvailable();
    return this.exec(cmd, cmd, args, opts, false);
  }

  private async exec(
    bin: string,
    label: string,
    args: string[],
    opts: RunOptions,
    withPath: boolean,
  ): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs;
    const extra: Record<string, string> = { ...(opts.env ?? {}) };
    const unset = [...(opts.unset ?? [])];
    let res: SpawnResult;
    if (!this.cfg.prefix) {
      const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
      for (const k of unset) delete env[k];
      if (withPath && this.cfg.binDir) env.PATH = `${this.cfg.binDir}${delimiter}${process.env.PATH ?? ""}`;
      try {
        res = await this.spawner(bin, args, { cwd: opts.cwd, env, timeoutMs, input: opts.input });
      } catch (e) {
        throw this.spawnError(label, e as NodeJS.ErrnoException);
      }
    } else {
      const fwd: Record<string, string> = {};
      for (const name of this.cfg.passEnv) {
        const v = process.env[name];
        if (v !== undefined) fwd[name] = v;
      }
      if (withPath && this.cfg.binDir) {
        const sidePath = (await this.sideEnv()).PATH ?? "/usr/local/bin:/usr/bin:/bin";
        fwd.PATH = `${this.cfg.binDir}:${sidePath}`;
      }
      Object.assign(fwd, extra);
      const cwd = opts.cwd ? await this.toSide(opts.cwd) : undefined;
      const argv = buildPrefixedArgv({
        prefix: this.cfg.prefix,
        cwd,
        env: fwd,
        unset,
        bin,
        args,
        style: this.cfg.style === "wsl" ? "wsl" : "generic",
      });
      try {
        res = await this.spawner(argv[0]!, argv.slice(1), { env: process.env, timeoutMs, input: opts.input });
      } catch (e) {
        throw this.spawnError(argv[0]!, e as NodeJS.ErrnoException);
      }
      if ((res.code === 4294967295 || res.code === -1) && looksUtf16(res.stdout)) {
        throw new Error(decodeWslError(res.stdout, this.distro()));
      }
    }
    const missing = (res.code === 127 || res.code === 1) && missingBinaryPath(res.stderr);
    if (missing) {
      const where = this.cfg.style === "wsl" ? " inside WSL" : "";
      throw new Error(
        `${label} not found at ${missing}${where}. Set ANSIBLE_MCP_BIN_DIR to the directory holding ansible-core's executables (e.g. a venv's bin).`,
      );
    }
    return { code: res.code, stdout: res.stdout.toString("utf8"), stderr: res.stderr };
  }

  private spawnError(label: string, e: NodeJS.ErrnoException): Error {
    if (e instanceof TimeoutError) return e;
    if (e.code === "ENOENT") {
      if (this.cfg.prefix) {
        return new Error(`could not run '${this.cfg.prefix[0]}' (ANSIBLE_MCP_COMMAND_PREFIX): not found.`);
      }
      return new Error(
        `${label} not found ${this.cfg.binDir ? `in ${this.cfg.binDir}` : "on PATH"}. Install ansible-core, or set ANSIBLE_MCP_BIN_DIR to the directory holding its executables (e.g. a venv's bin).`,
      );
    }
    return new Error(`could not run ${label}: ${e.message}`);
  }

  // --- Ansible-side file operations (fs natively, plumbing commands through a prefix) ---

  async sideReadFile(p: string): Promise<string | null> {
    if (!this.prefixed) {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    }
    const r = await this.raw("cat", ["--", p], {});
    return r.code === 0 ? r.stdout : null;
  }

  async sideMkdirp(p: string): Promise<void> {
    if (!this.prefixed) {
      mkdirSync(p, { recursive: true });
      return;
    }
    const r = await this.raw("mkdir", ["-p", "--", p], {});
    if (r.code !== 0) throw new Error(`could not create ${p}: ${r.stderr.trim()}`);
  }

  async sideWriteFile(p: string, content: string): Promise<void> {
    if (!this.prefixed) {
      writeFileSync(p, content, { mode: 0o600 });
      return;
    }
    const r = await this.raw("tee", ["--", p], { input: content });
    if (r.code !== 0) throw new Error(`could not write ${p}: ${r.stderr.trim()}`);
    await this.raw("chmod", ["600", "--", p], {});
  }

  /** Rename a directory; false when the target already exists (another process won). */
  async sideRename(from: string, to: string): Promise<boolean> {
    if (!this.prefixed) {
      try {
        if (existsSync(to)) return false;
        renameSync(from, to);
        return true;
      } catch {
        return false;
      }
    }
    const r = await this.raw("mv", ["-T", "--", from, to], {});
    return r.code === 0;
  }

  /** Recursive delete of a `.tmp-*` dir, only under `guardRoot` (asserted). */
  async sideRemoveTemp(p: string, guardRoot: string): Promise<void> {
    const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!norm(p).startsWith(`${norm(guardRoot)}/`) || !norm(p).includes("/.tmp-")) {
      throw new Error(`refusing to remove ${p}: not a temp dir under ${guardRoot}`);
    }
    if (!this.prefixed) {
      rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    }
    await this.raw(REMOVE_CMD, ["-r", "-f", "--", p], {});
  }
}

const REMOVE_CMD = "rm";

export interface SafetyOptions {
  vaultFile: string;
  cacheRoot: string;
  allowDynamicInventory: boolean;
  /** Ansible-side path join (posix in prefix mode). */
  join: (a: string, b: string) => string;
}

export const COLOR_ENV: Record<string, string> = { ANSIBLE_NOCOLOR: "1", ANSIBLE_FORCE_COLOR: "0", NO_COLOR: "1" };

/** Variables every Ansible child gets except `ansible-config dump` (design.md 4.2). */
export function safetyEnv(o: SafetyOptions): { env: Record<string, string>; unset: string[] } {
  const env: Record<string, string> = {
    ANSIBLE_VAULT_PASSWORD_FILE: o.vaultFile,
    ANSIBLE_VAULT_IDENTITY_LIST: `ansible-mcp@${o.vaultFile}`,
    ANSIBLE_ASK_VAULT_PASS: "False",
    ANSIBLE_ASK_PASS: "False",
    ANSIBLE_BECOME_ASK_PASS: "False",
    ANSIBLE_VARS_ENABLED: "host_group_vars",
    ANSIBLE_LOCAL_TEMP: o.join(o.cacheRoot, "local-tmp"),
    ANSIBLE_GALAXY_CACHE_DIR: o.join(o.cacheRoot, "galaxy-api"),
    ANSIBLE_RETRY_FILES_ENABLED: "False",
    ...COLOR_ENV,
  };
  if (!o.allowDynamicInventory) env.ANSIBLE_INVENTORY_ENABLED = "host_list,yaml,ini,toml";
  return { env, unset: ["ANSIBLE_VAULT_ID_MATCH"] };
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** Strip ANSI escapes (ansible-lint colours its --version output). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

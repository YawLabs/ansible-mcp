import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocJson } from "../ansibleDoc.js";
import type { DocResult } from "../context.js";
import type { Spawner, SpawnResult } from "../exec.js";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const PROJECT = join(FIXTURES, "project");
export const HOSTILE = join(FIXTURES, "hostile");
export const OUT = join(FIXTURES, "output");

export const readOut = (rel: string): string => readFileSync(join(OUT, rel), "utf8");
export const readOutJson = <T = any>(rel: string): T => JSON.parse(readOut(rel)) as T;

const tempDirs: string[] = [];

export function tempDir(prefix = "ansmcp-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

export function cleanupTempDirs(): void {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A leftover temp dir is not a test failure.
    }
  }
}

/** A temp copy of a committed fixture project. */
export function fixtureCopy(name: "project" | "hostile"): string {
  const d = tempDir(`ansmcp-${name}-`);
  cpSync(join(FIXTURES, name), d, { recursive: true });
  return d;
}

/** Every `ansible-doc --json` entry in the fixtures, keyed by the name it was asked as. */
export function installedDocDb(): Record<string, any> {
  const db: Record<string, any> = {};
  for (const f of [
    "doc/apt-short-name.json",
    "doc/copy.json",
    "doc/file.json",
    "doc/posix-mount-1.5.4.json",
    "doc/ufw-short-name.json",
    "doc/cg-git_config-9.5.2.json",
    "doc/multi-copy-sysctl.json",
    "upgrade/docs-installed.json",
  ]) {
    Object.assign(db, readOutJson(f));
  }
  // The project's short name `mount` resolves to ansible.posix.mount (ansible-core's builtin runtime redirect).
  db.mount = db["ansible.posix.mount"];
  // doc/apt-short-name.json was asked as `apt`; the doc is ansible.builtin.apt's either way.
  db["ansible.builtin.apt"] = db.apt;
  return db;
}

/** A DocResult built from the fixture docs for the given names (unknown names are missing). */
export function docResult(names: string[], db: Record<string, any> = installedDocDb()): DocResult {
  const sub: Record<string, any> = {};
  for (const n of names) if (db[n]) sub[n] = db[n];
  const docs = parseDocJson(JSON.stringify(sub));
  return { docs, missing: names.filter((n) => !db[n]), tombstones: [], deprecations: [] };
}

export interface Route {
  tool: string;
  /** Every listed string must appear in args (order-free). */
  has?: string[];
  /** None of these may appear. */
  not?: string[];
  /** Extra predicate on argv and the child's env. */
  when?: (args: string[], env: NodeJS.ProcessEnv) => boolean;
  stdout?: string | ((args: string[], env: NodeJS.ProcessEnv) => string);
  stderr?: string;
  code?: number;
}

export interface Recorded {
  tool: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

/** A Spawner that replays fixture output by tool name and argv content, recording every call. */
export function replaySpawner(routes: Route[], calls: Recorded[] = []): Spawner {
  return async (cmd, args, opts): Promise<SpawnResult> => {
    const tool = basename(cmd).replace(/\.exe$/i, "");
    calls.push({ tool, args, env: opts.env, cwd: opts.cwd });
    const r = routes.find(
      (x) =>
        x.tool === tool &&
        (x.has ?? []).every((h) => args.includes(h)) &&
        !(x.not ?? []).some((n) => args.includes(n)) &&
        (!x.when || x.when(args, opts.env)),
    );
    if (!r) throw Object.assign(new Error(`no route for ${tool} ${args.join(" ")}`), { code: "ENOENT" });
    const stdout = typeof r.stdout === "function" ? r.stdout(args, opts.env) : (r.stdout ?? "");
    return { code: r.code ?? 0, stdout: Buffer.from(stdout, "utf8"), stderr: r.stderr ?? "" };
  };
}

/** ansible-doc --json replay: returns the fixture entries for the names in argv. */
export function docRoute(db: Record<string, any> = installedDocDb()): Route {
  return {
    tool: "ansible-doc",
    has: ["--json"],
    stdout: (args) => {
      const out: Record<string, any> = {};
      for (const a of args) if (db[a]) out[a] = db[a];
      return JSON.stringify(out);
    },
  };
}

/** Rewrite the capture's absolute project path (/tmp/ansible-mcp-work/project) to `dir`. */
export function retarget(text: string, dir: string): string {
  return text.replaceAll("/tmp/ansible-mcp-work/project", dir.replace(/\\/g, "/"));
}

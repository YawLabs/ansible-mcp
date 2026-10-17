import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnsibleContext } from "../context.js";
import type { ExecConfig, Spawner, SpawnResult } from "../exec.js";
import { inventory, lintSummary, playbookStructure, roleInterface } from "../handlers.js";
import { PlainAnswer } from "../paths.js";
import { prescanPlaybook, prescanRefusal } from "../playbook.js";
import { ProjectFiles } from "../project.js";
import { get, parseYaml } from "../yaml.js";
import { cleanupTempDirs, type Recorded, readOut, replaySpawner, retarget, tempDir } from "./helpers.js";

/**
 * The R1 lookup pre-scan and the handler paths that feed it: YAML aliases,
 * the lookup pattern, playbooks outside dir, lint directory targets, lint
 * target translation, the inventory fallback's redaction order, and the role
 * basename handed to ansible-doc.
 */

const LINUX: ExecConfig = {
  prefix: null,
  binDir: null,
  style: "native",
  passEnv: [],
  timeoutMs: 10_000,
  platform: "linux",
};

function write(root: string, rel: string, text: string): string {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

const plainAnswer = async (f: () => Promise<string>): Promise<string> => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof PlainAnswer) return e.message;
    throw e;
  }
};

afterEach(() => cleanupTempDirs());

describe("YAML aliases (P1)", () => {
  it("resolves an alias to the anchored node's value", () => {
    const doc = parseYaml('vars:\n  h: &h "{{ x }}"\nhosts: *h\nlist: &l [1, 2]\nagain: *l\n');
    const hosts = get(doc.root, "hosts");
    expect(hosts?.kind).toBe("scalar");
    expect(hosts?.kind === "scalar" && hosts.value).toBe("{{ x }}");
    // The anchor's own line, where the text actually is.
    expect(hosts?.line).toBe(2);
    const again = get(doc.root, "again");
    expect(again?.kind === "seq" && again.items.map((i) => (i.kind === "scalar" ? i.value : null))).toEqual([1, 2]);
  });

  it("terminates on a self-referential alias", () => {
    const doc = parseYaml("a: &a\n  - *a\n");
    const a = get(doc.root, "a");
    expect(a?.kind).toBe("seq");
  });

  it("finds a lookup reached through an alias in play-level hosts", () => {
    const d = tempDir();
    write(
      d,
      "pb.yml",
      "- name: aliased\n  vars:\n    h: &h \"{{ lookup('pipe', 'id') }}\"\n  hosts: *h\n  tasks: []\n",
    );
    const hits = prescanPlaybook(new ProjectFiles(d), "pb.yml");
    expect(hits.map((h) => h.field)).toEqual(["hosts"]);
  });
});

describe("lookup pattern (P2)", () => {
  const scan = (hosts: string) => {
    const d = tempDir();
    write(d, "pb.yml", `- hosts: ${JSON.stringify(hosts)}\n  tasks: []\n`);
    return prescanPlaybook(new ProjectFiles(d), "pb.yml");
  };

  it("refuses lookup/query/pipe used without a direct call", () => {
    expect(scan("{% set f = lookup %}{{ f('pipe', 'id') }}")).toHaveLength(1);
    expect(scan("{{ (lookup)('env', 'HOME') }}")).toHaveLength(1);
    expect(scan("{% set f = query %}{{ f('x') }}")).toHaveLength(1);
    expect(scan("{{ q('env', 'HOME') }}")).toHaveLength(1);
  });

  it("does not flag a bare letter q or ordinary words", () => {
    expect(scan("qa")).toEqual([]);
    expect(scan("{{ q }}")).toEqual([]);
    expect(scan("web_lookups_servers")).toEqual([]);
  });
});

describe("playbooks outside dir and unreadable targets (C1)", () => {
  it("abs() keeps an absolute path and rel() keeps it outside dir", () => {
    const d = tempDir();
    const other = tempDir();
    const files = new ProjectFiles(d);
    const outside = join(other, "x.yml");
    expect(files.abs(outside)).toBe(outside);
    expect(files.rel(join(d, "a", "b.yml"))).toBe("a/b.yml");
  });

  it.runIf(process.platform === "win32")("rel() ignores drive-letter case on Windows", () => {
    const d = tempDir();
    const files = new ProjectFiles(d);
    const flipped = d[0] === d[0]!.toUpperCase() ? d[0]!.toLowerCase() + d.slice(1) : d[0]!.toUpperCase() + d.slice(1);
    expect(files.rel(join(flipped, "pb.yml"))).toBe("pb.yml");
  });

  it("scans a playbook named by an absolute path outside dir", () => {
    const d = tempDir();
    const other = tempDir();
    const pb = write(other, "x.yml", "- hosts: \"{{ lookup('pipe', 'id') }}\"\n  tasks: []\n");
    const hits = prescanPlaybook(new ProjectFiles(d), pb);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.field).toBe("hosts");
  });

  it("refuses a target that cannot be read instead of counting it clean", () => {
    const d = tempDir();
    const hits = prescanPlaybook(new ProjectFiles(d), "missing.yml");
    expect(hits).toHaveLength(1);
    expect(prescanRefusal(hits)).toMatch(/missing\.yml could not be read for the lookup pre-scan/);
  });

  it("playbook_structure refuses a ../ playbook with a lookup before spawning", async () => {
    const root = tempDir();
    mkdirSync(join(root, "proj"));
    write(root, "x.yml", "- hosts: \"{{ lookup('pipe', 'id') }}\"\n  tasks: []\n");
    const calls: Recorded[] = [];
    const ctx = new AnsibleContext({ exec: LINUX, spawner: replaySpawner([], calls), cacheDir: tempDir() });
    const out = await plainAnswer(() =>
      playbookStructure(ctx, { playbook: "../x.yml", dir: join(root, "proj"), maxTasks: 10 }),
    );
    expect(out).toMatch(/has a lookup in 'hosts'/);
    expect(calls.filter((c) => c.tool === "ansible-playbook")).toEqual([]);
  });
});

describe("lint pre-scan coverage (C2)", () => {
  const lintCtx = (calls: Recorded[]) =>
    new AnsibleContext({
      exec: LINUX,
      spawner: replaySpawner(
        [
          { tool: "ansible-lint", has: ["--version"], stdout: "ansible-lint 26.10.1\n" },
          { tool: "ansible-lint", stdout: "[]" },
        ],
        calls,
      ),
      cacheDir: tempDir(),
    });
  const BAD = "- hosts: \"{{ lookup('pipe', 'id') }}\"\n  tasks: []\n";

  it("walks a directory target to any depth", async () => {
    const d = tempDir();
    write(d, "playbooks/a/b/c/d/deep.yml", BAD);
    const calls: Recorded[] = [];
    const out = await lintSummary(lintCtx(calls), { dir: d, paths: ["."], maxLocations: 5 });
    expect(out).toMatch(/playbooks\/a\/b\/c\/d\/deep\.yml:1 .*has a lookup in 'hosts'/);
    const out2 = await lintSummary(lintCtx(calls), { dir: d, paths: ["playbooks"], maxLocations: 5 });
    expect(out2).toMatch(/has a lookup in 'hosts'/);
    expect(calls.filter((c) => c.tool === "ansible-lint")).toEqual([]);
  });

  it("walks the whole project when no paths are given, including roles/ and collections/", async () => {
    for (const rel of ["roles/r/files/pb.yml", "collections/pb.yml", "group_vars/pb.yml", "a/b/c/d/e/pb.yml"]) {
      const d = tempDir();
      write(d, rel, BAD);
      const calls: Recorded[] = [];
      const out = await lintSummary(lintCtx(calls), { dir: d, maxLocations: 5 });
      expect(out, rel).toMatch(/has a lookup in 'hosts'/);
      expect(calls.filter((c) => c.tool === "ansible-lint")).toEqual([]);
    }
  });

  it("still lints a clean tree", async () => {
    const d = tempDir();
    write(d, "playbooks/a/b/c/d/ok.yml", "- hosts: all\n  tasks: []\n");
    write(d, "roles/r/tasks/main.yml", "- name: lookup('x') in a task name is not play-level\n  debug: {}\n");
    const calls: Recorded[] = [];
    const out = await lintSummary(lintCtx(calls), { dir: d, paths: ["."], maxLocations: 5 });
    expect(out).toMatch(/^ansible-lint 26\.10\.1/);
  });
});

describe("lint targets cross into WSL (C6)", () => {
  it.runIf(process.platform === "win32")("translates a target outside dir and keeps inside ones relative", async () => {
    const d = tempDir();
    const other = tempDir();
    write(d, "site.yml", "- hosts: all\n  tasks: []\n");
    const outside = write(other, "x.yml", "- hosts: all\n  tasks: []\n");
    const calls: Recorded[] = [];
    const spawner: Spawner = async (cmd, args, opts): Promise<SpawnResult> => {
      calls.push({ tool: cmd, args, env: opts.env });
      const ok = (s: string): SpawnResult => ({ code: 0, stdout: Buffer.from(s, "utf8"), stderr: "" });
      if (args.includes("wslpath")) return ok("/mnt/c/\n");
      if (args.includes("cat")) return ok(`${"a".repeat(64)}\n`);
      if (args.includes("ansible-lint")) return ok(args.includes("--version") ? "ansible-lint 26.10.1\n" : "[]");
      return ok("");
    };
    const ctx = new AnsibleContext({
      exec: {
        prefix: ["wsl", "-d", "Ubuntu", "--exec"],
        binDir: null,
        style: "wsl",
        passEnv: [],
        timeoutMs: 1000,
        platform: "win32",
      },
      spawner,
      cacheDir: tempDir(),
      remoteCache: "/rc",
    });
    await lintSummary(ctx, { dir: d, paths: ["site.yml", outside], maxLocations: 5 });
    const lint = calls.find((c) => c.args.includes("ansible-lint") && c.args.includes("codeclimate"))!;
    expect(lint).toBeDefined();
    const tail = lint.args.slice(lint.args.indexOf("codeclimate") + 1);
    const drive = outside[0]!.toLowerCase();
    expect(tail).toEqual(["site.yml", `/mnt/${drive}${outside.slice(2).replace(/\\/g, "/")}`]);
  });
});

describe("inventory fallback redaction order (P9)", () => {
  it("hides an inventory-file secret copied into a group_vars file under a plain key", async () => {
    const d = tempDir();
    write(d, "inventory/hosts.yml", "all:\n  hosts:\n    web1:\n");
    write(d, "inventory/group_vars/all/vault.yml", "$ANSIBLE_VAULT;1.1;AES256\n6162\n");
    write(d, "inventory/group_vars/all/plain.yml", "note: copiedsecretvalue\n");
    const r = (rel: string) => retarget(readOut(rel), d);
    const ctx = new AnsibleContext({
      exec: LINUX,
      spawner: replaySpawner([
        { tool: "ansible", has: ["--version"], stdout: r("version.txt") },
        { tool: "ansible-config", has: ["dump"], stdout: r("config/only-changed.json") },
        { tool: "ansible-inventory", has: ["--graph"], stdout: "@all:\n  |--@ungrouped:\n  |  |--web1\n" },
        {
          tool: "ansible-inventory",
          has: ["--list"],
          when: (_a, env) => env.ANSIBLE_VARS_ENABLED === "none",
          stdout: JSON.stringify({ _meta: { hostvars: { web1: { db_password: "copiedsecretvalue" } } } }),
        },
        { tool: "ansible-inventory", has: ["--list"], code: 4, stderr: r("inventory/list-no-vault-secret.stderr") },
      ]),
      cacheDir: tempDir(),
    });
    const out = await inventory(ctx, { dir: d, inventory: "inventory/hosts.yml", vars: "values", limit: 50 });
    expect(out).toMatch(/degraded:/);
    expect(out).toMatch(/note = /);
    expect(out).not.toContain("copiedsecretvalue");
  });
});

describe("role basename handed to ansible-doc (C3)", () => {
  it("refuses a role dir whose basename starts with '-'", async () => {
    const d = tempDir();
    write(d, "roles/sub/-x/tasks/main.yml", "- debug: {}\n");
    const calls: Recorded[] = [];
    const ctx = new AnsibleContext({
      exec: LINUX,
      spawner: replaySpawner(
        [
          { tool: "ansible-config", has: ["dump"], stdout: "[]" },
          { tool: "ansible-doc", stdout: "{}" },
        ],
        calls,
      ),
      cacheDir: tempDir(),
    });
    const out = await plainAnswer(() => roleInterface(ctx, { role: "sub/-x", dir: d, descriptionChars: 100 }));
    expect(out).toMatch(/must not start with '-'/);
    expect(calls.filter((c) => c.tool === "ansible-doc")).toEqual([]);
  });
});

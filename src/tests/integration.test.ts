import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnsibleRunner, type ExecConfig, readExecConfig, TimeoutError } from "../exec.js";
import { winToWsl } from "../paths.js";
import { createAnsibleMcpServer } from "../server.js";
import { cleanupTempDirs, FIXTURES, tempDir } from "./helpers.js";

/**
 * Real Ansible, end to end (design.md section 8, Integration). Skipped cleanly
 * when Ansible is not reachable.
 *
 * - Linux/macOS: native `ansible-doc` on PATH, or ANSIBLE_MCP_TEST_BIN_DIR.
 * - Windows: through WSL. ANSIBLE_MCP_TEST_PREFIX (default ["wsl.exe","-d","Ubuntu","--exec"])
 *   and ANSIBLE_MCP_TEST_BIN_DIR (default /tmp/ansible-mcp-venv/bin, the fixtures README's venv).
 * - ANSIBLE_MCP_TEST_COLLECTIONS_PATH: the "installed set" (ansible.posix 1.5.4 and
 *   community.general 9.5.2; default /tmp/ansible-mcp-work/collections on Windows).
 *   Tests that need those collections skip when they are absent.
 * - ANSIBLE_MCP_TEST_BIG=1 adds community.general 9.5.2 -> 12.0.0 (about 56 MB, 30-50 s).
 *
 * Everything the tests write goes under one Ansible-side work dir (copies of
 * the fixtures, the server's caches, ANSIBLE_HOME for the test's own probe
 * commands), removed afterwards. The server gets no ANSIBLE_HOME: the first test
 * checks that ~/.ansible on the Ansible side is left alone, and the user's
 * collections paths are never written.
 */

const isWin = process.platform === "win32";
const PREFIX_RAW = process.env.ANSIBLE_MCP_TEST_PREFIX ?? (isWin ? '["wsl.exe","-d","Ubuntu","--exec"]' : "");
const BIN_DIR = process.env.ANSIBLE_MCP_TEST_BIN_DIR ?? (isWin ? "/tmp/ansible-mcp-venv/bin" : "");
const COLLS = process.env.ANSIBLE_MCP_TEST_COLLECTIONS_PATH ?? (isWin ? "/tmp/ansible-mcp-work/collections" : "");
const BIG = process.env.ANSIBLE_MCP_TEST_BIG === "1";

const execCfg: ExecConfig = readExecConfig(
  { ANSIBLE_MCP_COMMAND_PREFIX: PREFIX_RAW, ANSIBLE_MCP_BIN_DIR: BIN_DIR, ANSIBLE_MCP_TIMEOUT_MS: "180000" },
  process.platform,
);
const prefix = execCfg.prefix;

/** Run a setup command on the Ansible side (tests may use a shell here; the server never does). */
function side(args: string[], timeout = 120_000): { code: number | null; out: string; err: string } {
  const [cmd, ...rest] = prefix ? [...prefix, ...args] : args;
  const r = spawnSync(cmd!, rest, { encoding: "utf8", timeout, windowsHide: true });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const RUN = randomBytes(4).toString("hex");
/** Ansible-side work dir. */
const WORK = isWin ? `/tmp/ansible-mcp-it-${RUN}` : join(tmpdir(), `ansible-mcp-it-${RUN}`);

/** An Ansible command run by the TEST, kept out of ~/.ansible like the server's own. */
function ansibleSide(args: string[], timeout = 120_000) {
  return side(
    [
      "env",
      `ANSIBLE_HOME=${WORK}/home`,
      `ANSIBLE_LOCAL_TEMP=${WORK}/home/tmp`,
      `ANSIBLE_GALAXY_CACHE_DIR=${WORK}/home/galaxy`,
      ...(COLLS ? [`ANSIBLE_COLLECTIONS_PATH=${COLLS}`] : []),
      ...args,
    ],
    timeout,
  );
}

const bin = (t: string) => (BIN_DIR ? `${BIN_DIR}/${t}` : t);
const reachable = (() => {
  if (isWin && !prefix) return false;
  try {
    return ansibleSide([bin("ansible-doc"), "--version"], 60_000).code === 0;
  } catch {
    return false;
  }
})();
const hasCollections =
  reachable &&
  ansibleSide([bin("ansible-galaxy"), "collection", "list", "--format", "json"]).out.includes(
    '"ansible.posix": {"version": "1.5.4"}',
  );

/** mtimes of ~/.ansible and ~/.ansible/tmp on the Ansible side ("" when absent). */
function homeAnsibleStamp(): string {
  return side([
    "sh",
    "-c",
    'stat -c "%n %Y" "$HOME/.ansible" "$HOME/.ansible/tmp" "$HOME/.ansible/galaxy_cache" 2>/dev/null; true',
  ]).out;
}

const distro = (() => {
  if (!prefix) return null;
  const i = prefix.indexOf("-d");
  return i >= 0 ? prefix[i + 1]! : null;
})();
/** The work dir as the server sees it. */
const SERVER_WORK = isWin ? `\\\\wsl.localhost\\${distro}${WORK.replace(/\//g, "\\")}` : WORK;
const MARKS = "/tmp/ansible-mcp-marks";

function toSideFixture(p: string): string {
  return isWin ? winToWsl(p, "/mnt/")! : p;
}

/**
 * Forwarded to the Ansible side. Deliberately NOT ANSIBLE_HOME / ANSIBLE_LOCAL_TEMP:
 * the server itself must keep Ansible out of ~/.ansible, and the tests check it.
 * XDG_CACHE_HOME keeps ansible-lint's cache in the work dir.
 */
const ENV_KEYS = ["ANSIBLE_COLLECTIONS_PATH", "XDG_CACHE_HOME", "ANSIBLE_MCP_MARK_DIR"];

async function connect(extra: { allowPlayLookups?: boolean; passEnv?: string[] } = {}) {
  const server = createAnsibleMcpServer({
    exec: { ...execCfg, passEnv: [...ENV_KEYS, ...(extra.passEnv ?? [])] },
    remoteCache: `${WORK}/cache`,
    cacheDir: isWin ? tempDir() : `${WORK}/cache`,
    allowPlayLookups: extra.allowPlayLookups ?? false,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "it", version: "0" }, { capabilities: {} });
  await Promise.all([client.connect(a), server.connect(b)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[]).map((c) => c.text).join("\n");
  return { text, isError: res.isError === true };
}

/** Paths, sizes and mtimes of every file under `dir` (server side). */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        out.push(`${p.slice(dir.length)} ${st.size} ${st.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function markers(): string[] {
  const r = side(["ls", "-1", MARKS]);
  return r.code === 0 ? r.out.split("\n").filter(Boolean).sort() : [];
}

const SENTINELS = /FIXTURE-SECRET|FIXTURE-plain/;

describe.skipIf(!reachable)("integration: real Ansible", () => {
  let client: Client;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ANSIBLE_COLLECTIONS_PATH = COLLS || undefined;
    process.env.XDG_CACHE_HOME = `${WORK}/xdg`;
    process.env.ANSIBLE_MCP_MARK_DIR = MARKS;
    if (!COLLS) delete process.env.ANSIBLE_COLLECTIONS_PATH;
    expect(side(["mkdir", "-p", WORK]).code).toBe(0);
    for (const name of ["project", "hostile"]) {
      expect(side(["cp", "-r", toSideFixture(join(FIXTURES, name)), `${WORK}/${name}`]).code).toBe(0);
    }
    // DrvFs copies arrive as 0777, and Ansible ignores a cfg in a world-writable dir (F22).
    side(["chmod", "-R", "u=rwX,go=rX", WORK]);
    side(["chmod", "+x", `${WORK}/hostile/vault-pass.sh`, `${WORK}/hostile/inventory/inv.sh`]);
    client = await connect();
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    side(["rm", "-r", "-f", WORK]);
    side(["rm", "-r", "-f", MARKS]);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    cleanupTempDirs();
  }, 120_000);

  const P = () => `${SERVER_WORK}${isWin ? "\\" : "/"}project`;
  const H = () => `${SERVER_WORK}${isWin ? "\\" : "/"}hostile`;

  it("every read-only tool answers on the fixture project and leaves it untouched", {
    timeout: 600_000,
  }, async (ctx) => {
    if (!hasCollections) ctx.skip("installed set (ansible.posix 1.5.4, community.general 9.5.2) not found");
    const before = snapshot(P());
    const homeBefore = homeAnsibleStamp();
    const outputs: Record<string, string> = {};
    const run = async (name: string, args: Record<string, unknown>) => {
      const r = await call(client, name, { dir: P(), ...args });
      expect(r.isError, `${name}: ${r.text}`).toBe(false);
      expect(r.text, name).not.toMatch(SENTINELS);
      outputs[name + JSON.stringify(args)] = r.text;
      return r.text;
    };
    expect(await run("ansible_project_info", {})).toMatch(/playbooks \(1\): playbooks\/site\.yml \(3 plays\)/);
    expect(await run("ansible_module_doc", { name: "ufw" })).toMatch(
      /^community\.general\.ufw \(module, community\.general 9\.5\.2\) \[resolved from 'ufw'\]/,
    );
    expect(await run("ansible_module_search", { query: "firewall", collection: "ansible.posix" })).toContain(
      "ansible.posix.firewalld - Manage arbitrary ports/services with firewalld",
    );
    const checked = await run("ansible_check_task_args", { file: "playbooks/tasks/bad_args.yml" });
    expect(checked.split("\n")[0]).toMatch(
      /: 7 tasks checked against installed docs \(ansible-core [\d.]+ via .*\): 5 problems in 3 tasks$|: 7 tasks checked against installed docs \(ansible-core [\d.]+\): 5 problems in 3 tasks$/,
    );
    expect(checked).toContain("    proto (line 41): 'tcpx' is not one of any|tcp|udp|ipv6|esp|ah|gre|igmp");
    expect(await run("ansible_role_interface", { role: "webapp" })).toContain(
      "WARNING choice false comes from unquoted 'off'",
    );
    const inv = await run("ansible_inventory", {});
    expect(inv).toMatch(/3 hosts, 5 groups/);
    expect(inv).toMatch(/^degraded: .*inventory\/group_vars\/all\/vault\.yml is a whole-file vault/m);
    await run("ansible_inventory", { host: "web1" });
    expect(await run("ansible_inventory", { host: "nope" })).toBe("host 'nope' is not in this inventory");
    const pb = await run("ansible_playbook_structure", { playbook: "playbooks/site.yml" });
    expect(pb).toMatch(/syntax ok, 3 plays, 15 tasks, hosts matched 3/);
    expect(pb).toContain("Git identity [db, git] community.general.git_config playbooks/site.yml:17");
    expect(await run("ansible_config", {})).toContain("DEFAULT_FORKS = 7  (ansible.cfg)");
    expect(await run("ansible_collections", {})).toContain(
      "ansible.posix 2.0.0: installed 1.5.4 VIOLATES (requirements.yml:5)",
    );
    // Nothing under an existing ~/.ansible on the Ansible side was created or written by the
    // Ansible commands (F15: local_tmp, galaxy cache are redirected).
    expect(homeAnsibleStamp()).toBe(homeBefore);
    // ansible-lint last, with HOME in the work dir: ansible-compat creates the DEFAULT
    // roles/collections dirs under ~/.ansible when they are missing (empty dirs;
    // documented residue, design.md 4.3), and the test must not do that to a real home.
    const savedHome = process.env.HOME;
    process.env.HOME = `${WORK}/home`;
    const lintClient = await connect({ passEnv: ["HOME"] });
    try {
      const lint = await call(lintClient, "ansible_lint_summary", { dir: P() });
      expect(lint.isError, lint.text).toBe(false);
      expect(lint.text).not.toMatch(SENTINELS);
      expect(lint.text).toMatch(/^ansible-lint [\d.]+ \(offline\): \d+ failures?, \d+ warnings?/);
    } finally {
      await lintClient.close();
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
    expect(homeAnsibleStamp()).toBe(homeBefore);
    expect(snapshot(P())).toEqual(before);
    expect(side(["test", "-e", `${WORK}/project/.ansible`]).code).not.toBe(0);
  });

  it("never runs the hostile project's hooks, and pins the documented residue (R1)", { timeout: 300_000 }, async () => {
    side(["rm", "-r", "-f", MARKS]);
    for (const [name, args] of [
      ["ansible_project_info", {}],
      ["ansible_config", {}],
      ["ansible_inventory", {}],
      ["ansible_inventory", { host: "h1" }],
      ["ansible_module_doc", { name: "ansible.builtin.debug" }],
      ["ansible_playbook_structure", { playbook: "play.yml" }],
      ["ansible_lint_summary", {}],
    ] as [string, Record<string, unknown>][]) {
      const r = await call(client, name, { dir: H(), ...args });
      expect(r.isError, `${name}: ${r.text}`).toBe(false);
      if (name === "ansible_inventory" && !args.host)
        expect(r.text).toMatch(/skipped \(dynamic, not allowed\): inventory\/inv\.sh/);
      if (name === "ansible_playbook_structure" || name === "ansible_lint_summary") expect(r.text).toMatch(/Not run\./);
    }
    expect(markers()).toEqual([]);

    const allow = await connect({ allowPlayLookups: true });
    try {
      const r = await call(allow, "ansible_playbook_structure", { dir: H(), playbook: "play.yml" });
      expect(r.isError, r.text).toBe(false);
      expect(r.text).toContain(
        "local plugins loaded by Ansible: filter_plugins/marker_filter.py, vars_plugins/marker_vars.py",
      );
    } finally {
      await allow.close();
    }
    // Exactly the residue design.md R1 documents; vault-password-script, inventory-script and the rest never ran.
    expect(markers()).toEqual(["hosts-lookup", "play-name-lookup", "vars-files-lookup", "vars-plugin-import"]);
  });

  it.skipIf(!isWin)(
    "reports ansible.cfg in a DrvFs checkout by setting ANSIBLE_CONFIG (F22)",
    { timeout: 120_000 },
    async (ctx) => {
      if (!hasCollections) ctx.skip("installed set not found");
      const d = tempDir("ansmcp-drvfs-");
      cpSync(join(FIXTURES, "project"), d, { recursive: true });
      const r = await call(client, "ansible_config", { dir: d });
      expect(r.isError, r.text).toBe(false);
      expect(r.text).toMatch(
        /config file ansible\.cfg \[set via ANSIBLE_CONFIG: DrvFs reports Windows folders as world-writable\]/,
      );
      expect(r.text).toContain("DEFAULT_FORKS = 7  (ansible.cfg)");
    },
  );

  it("ansible_upgrade_impact: ansible.posix 1.5.4 -> 2.0.0 downloads once, then answers offline from the cache", {
    timeout: 600_000,
  }, async (ctx) => {
    if (!hasCollections) ctx.skip("installed set not found");
    const homeBefore = homeAnsibleStamp();
    const first = await call(client, "ansible_upgrade_impact", {
      dir: P(),
      collection: "ansible.posix",
      version: "2.0.0",
    });
    if (/could not reach/.test(first.text)) ctx.skip(`offline: ${first.text}`);
    expect(first.isError, first.text).toBe(false);
    // ansible-galaxy creates ~/.ansible/galaxy_token when missing; the server points it at its cache instead.
    expect(homeAnsibleStamp()).toBe(homeBefore);
    const expectFindings = (t: string) => {
      expect(t).toContain(
        "BEHAVIOR CHANGES (1):\n  roles/webapp/tasks/main.yml:13 ansible.posix.firewalld: offline not set; default null -> false",
      );
      expect(t).toContain(
        "INFO (1):\n  roles/webapp/tasks/main.yml:13 ansible.posix.firewalld: masquerade type str -> bool; value 'yes' still converts (line 17)",
      );
      expect(t).toContain(
        "constraints: requirements.yml:5 pins '2.0.0' (satisfied by the target; installed 1.5.4 violates it today)",
      );
      expect(t).toContain("syntax-check with 2.0.0: ok");
      expect(t.split("\n").at(-1)).toBe("verdict: BEHAVIOR CHANGES (1)");
    };
    expectFindings(first.text);
    expect(first.text).toMatch(/dependencies: none; downloaded \(cache: /);

    const prevProxy = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    const offline = await connect({ passEnv: ["HTTPS_PROXY"] });
    try {
      const second = await call(offline, "ansible_upgrade_impact", {
        dir: P(),
        collection: "ansible.posix",
        version: "2.0.0",
      });
      expect(second.isError, second.text).toBe(false);
      expect(second.text).toMatch(/dependencies: none; cached \(cache: /);
      expectFindings(second.text);
      const gone = await call(offline, "ansible_upgrade_impact", {
        dir: P(),
        collection: "ansible.posix",
        version: "1.6.2",
      });
      expect(gone.text).toMatch(
        /^could not reach galaxy\.ansible\.com to download ansible\.posix 1\.6\.2 \(offline or proxy\)\. Cached targets: 2\.0\.0\./,
      );
    } finally {
      await offline.close();
      if (prevProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = prevProxy;
    }
    const bad = await call(client, "ansible_upgrade_impact", {
      dir: P(),
      collection: "ansible.posix",
      version: "99.0.0",
    });
    expect(bad.text).toMatch(/^ansible\.posix 99\.0\.0 was not found on the configured Galaxy servers/);
    expect(side(["sh", "-c", `ls -a ${WORK}/cache/collections/ansible.posix`]).out).not.toMatch(/\.tmp-/);
    // The installed set is unchanged.
    expect(
      ansibleSide([bin("ansible-galaxy"), "collection", "list", "ansible.posix", "--format", "json"]).out,
    ).toContain('"version": "1.5.4"');
  });

  it.skipIf(!BIG)(
    "ansible_upgrade_impact: community.general 9.5.2 -> 12.0.0 (ANSIBLE_MCP_TEST_BIG=1)",
    { timeout: 900_000 },
    async (ctx) => {
      if (!hasCollections) ctx.skip("installed set not found");
      const r = await call(client, "ansible_upgrade_impact", {
        dir: P(),
        collection: "community.general",
        version: "12.0.0",
      });
      expect(r.isError, r.text).toBe(false);
      expect(r.text).toContain("BREAKING (5):");
      expect(r.text).toContain("playbooks/site.yml:17 community.general.git_config: option list_all removed (line 19)");
      expect(r.text).toContain(
        "playbooks/site.yml:23 community.general.proxmox_kvm: moved to community.proxmox.proxmox_kvm; community.proxmox is not installed (add it to requirements.yml)",
      );
      expect(r.text).toMatch(
        /syntax-check with 12\.0\.0 \(playbooks\/site\.yml\): first error playbooks\/site\.yml:22: couldn't resolve module\/action 'community\.general\.proxmox_kvm'/,
      );
      expect(r.text.split("\n").at(-1)).toBe("verdict: BREAKING (5)");
    },
  );

  it.skipIf(!isWin)(
    "WSL plumbing: argv round-trip, kill on timeout, bad distro, missing binary (F20, F23)",
    { timeout: 120_000 },
    async () => {
      const runner = new AnsibleRunner(execCfg);
      const tricky = [
        "a b",
        'q"uote',
        "dollar $HOME",
        "semi;colon",
        "star *",
        "back\\slash",
        "tab\there",
        "",
        "ünï",
        "trail\\",
        "%PATH%",
        "it's",
        "`tick`",
        "C:\\Users\\jeff",
      ];
      const r = await runner.raw("printf", ["[%s]\\n", ...tricky], {});
      expect(r.stdout).toBe(tricky.map((t) => `[${t}]\n`).join(""));
      await expect(runner.raw("sleep", ["30"], { timeoutMs: 1500 })).rejects.toBeInstanceOf(TimeoutError);
      const badDistro = new AnsibleRunner({
        ...execCfg,
        prefix: ["wsl.exe", "-d", "NoSuchDistro-ansible-mcp", "--exec"],
      });
      await expect(badDistro.run("ansible", ["--version"])).rejects.toThrow(
        /WSL distro 'NoSuchDistro-ansible-mcp' not found/,
      );
      const noBin = new AnsibleRunner({ ...execCfg, binDir: "/nonexistent/bin" });
      await expect(noBin.run("ansible-doc", ["--version"])).rejects.toThrow(
        /ansible-doc not found at \/nonexistent\/bin\/ansible-doc inside WSL\. Set ANSIBLE_MCP_BIN_DIR/,
      );
    },
  );
});

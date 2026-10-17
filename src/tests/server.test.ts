import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecConfig } from "../exec.js";
import { createAnsibleMcpServer, NATIVE_WINDOWS_MESSAGE, version } from "../server.js";
import {
  cleanupTempDirs,
  docRoute,
  fixtureCopy,
  OUT,
  type Recorded,
  type Route,
  readOut,
  replaySpawner,
  retarget,
  tempDir,
} from "./helpers.js";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

const LINUX: ExecConfig = {
  prefix: null,
  binDir: null,
  style: "native",
  passEnv: [],
  timeoutMs: 10_000,
  platform: "linux",
};
const SENTINELS = /FIXTURE-SECRET|FIXTURE-plain/;

/** Replays the committed captures with the project path rewritten to `dir`. */
function routes(dir: string, extra: Route[] = []): Route[] {
  const r = (rel: string) => retarget(readOut(rel), dir);
  return [
    ...extra,
    { tool: "ansible", has: ["--version"], stdout: r("version.txt") },
    { tool: "ansible-config", has: ["dump"], stdout: r("config/only-changed.json") },
    {
      tool: "ansible-galaxy",
      has: ["collection", "list", "community.general"],
      stdout: r("galaxy/collection-list-one.json"),
    },
    {
      tool: "ansible-galaxy",
      has: ["collection", "list", "ansible.posix"],
      stdout: '{"/tmp/ansible-mcp-work/collections/ansible_collections": {"ansible.posix": {"version": "1.5.4"}}}',
    },
    { tool: "ansible-galaxy", has: ["collection", "list"], stdout: r("galaxy/collection-list.json") },
    { tool: "ansible-galaxy", has: ["role", "list"], stdout: r("galaxy/role-list.txt") },
    { tool: "ansible-doc", has: ["-t", "role"], stdout: r("doc/role-webapp.json") },
    { tool: "ansible-doc", has: ["-l", "-j", "ansible.posix"], stdout: r("doc/list-module-ansible.posix.json") },
    { tool: "ansible-doc", has: ["-l", "-j"], stdout: r("doc/list-module-ansible.posix.json") },
    { tool: "ansible-doc", has: ["--version"], stdout: "ansible-doc [core 2.21.5]\n" },
    docRoute(),
    { tool: "ansible-inventory", has: ["--graph"], stdout: r("inventory/graph.txt") },
    { tool: "ansible-inventory", has: ["--host", "nope"], code: 5, stderr: r("inventory/host-missing.stderr") },
    { tool: "ansible-inventory", has: ["--host"], stdout: r("inventory/host-web1.json") },
    {
      tool: "ansible-inventory",
      has: ["--list"],
      when: (_a, env) => env.ANSIBLE_VARS_ENABLED === "none",
      stdout: r("inventory/list-vars-plugins-off.json"),
    },
    { tool: "ansible-inventory", has: ["--list"], code: 4, stderr: r("inventory/list-no-vault-secret.stderr") },
    { tool: "ansible-inventory", has: ["--version"], stdout: "ansible-inventory [core 2.21.5]\n" },
    {
      tool: "ansible-playbook",
      has: ["--syntax-check"],
      stdout: r("playbook/syntax-check.stdout"),
      stderr: r("playbook/syntax-check.stderr"),
    },
    { tool: "ansible-playbook", has: ["--list-tasks"], stdout: r("playbook/list-all.txt") },
    { tool: "ansible-playbook", has: ["--version"], stdout: "ansible-playbook [core 2.21.5]\n" },
    { tool: "ansible-lint", has: ["--version"], stdout: r("lint/version.txt") },
    {
      tool: "ansible-lint",
      has: ["-f", "codeclimate"],
      code: 2,
      stdout: r("lint/project.codeclimate.json"),
      stderr: r("lint/project.stderr"),
    },
    { tool: "ansible-galaxy", has: ["--version"], stdout: "ansible-galaxy [core 2.21.5]\n" },
    { tool: "ansible-config", has: ["--version"], stdout: "ansible-config [core 2.21.5]\n" },
  ];
}

async function connect(opts: Parameters<typeof createAnsibleMcpServer>[0]) {
  const server = createAnsibleMcpServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ansible-mcp-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function textOf(res: Awaited<ReturnType<Client["callTool"]>>): string {
  return (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

const EXPECTED_TOOLS = [
  "ansible_check_task_args",
  "ansible_collections",
  "ansible_config",
  "ansible_inventory",
  "ansible_lint_summary",
  "ansible_module_doc",
  "ansible_module_search",
  "ansible_playbook_structure",
  "ansible_project_info",
  "ansible_role_interface",
  "ansible_upgrade_impact",
];

describe("server", () => {
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
    cleanupTempDirs();
  });

  it("reports the package.json version", () => {
    expect(version).toBe(pkg.version);
  });

  it("lists the eleven tools with titles, annotations, capped strings and the instructions", async () => {
    client = await connect({ exec: LINUX, spawner: replaySpawner([]), cacheDir: tempDir() });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.description, t.name).toBeTruthy();
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.annotations?.idempotentHint).toBe(true);
      expect(t.annotations?.openWorldHint, t.name).toBe(t.name === "ansible_upgrade_impact");
      expect(t.inputSchema.properties).toHaveProperty("dir");
      for (const [name, p] of Object.entries(t.inputSchema.properties ?? {}) as [string, any][]) {
        if (p.type === "string") expect(p.maxLength, `${t.name}.${name}`).toBeGreaterThan(0);
        if (p.type === "number" || p.type === "integer") {
          expect(p.minimum, `${t.name}.${name}`).toBeDefined();
          expect(p.maximum, `${t.name}.${name}`).toBeDefined();
        }
        if (p.type === "array") {
          expect(p.maxItems, `${t.name}.${name}`).toBeGreaterThan(0);
          expect(p.items.maxLength, `${t.name}.${name}[]`).toBeGreaterThan(0);
        }
      }
    }
    const instructions = client.getInstructions() ?? "";
    for (const t of tools) expect(instructions).toContain(t.name);
    expect(instructions).toMatch(/never runs a play/);
    expect(instructions).toMatch(/AAP MCP/);
    expect(instructions).toMatch(/ADT MCP/);
    for (const name of ["ansible_playbook_structure", "ansible_lint_summary"]) {
      expect(tools.find((t) => t.name === name)?.description).toMatch(
        /treat dir as code you would run --syntax-check on/,
      );
    }
    expect(tools.find((t) => t.name === "ansible_upgrade_impact")?.description).toMatch(/never touches dir/);
  });

  it("answers every tool on the fixture project from replayed captures, with no secret in any output", async () => {
    const dir = fixtureCopy("project");
    const calls: Recorded[] = [];
    client = await connect({
      exec: LINUX,
      spawner: replaySpawner(routes(dir), calls),
      cacheDir: tempDir(),
      defaultDir: dir,
    });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client!.callTool({ name, arguments: args });
      const t = textOf(res);
      expect(res.isError, `${name}: ${t}`).toBeFalsy();
      expect(t, name).not.toMatch(SENTINELS);
      return t;
    };

    const info = await call("ansible_project_info");
    expect(info).toMatch(/^ansible project .* \(ansible-core 2\.21\.5, python 3\.12\.14, jinja 3\.1\.6\)$/m);
    expect(info).toContain("config file: ansible.cfg");
    expect(info).toContain("playbooks (1): playbooks/site.yml (3 plays)");
    expect(info).toContain(
      "inventories (1): inventory/hosts.yml (yaml, from ansible.cfg) + group_vars/host_vars (1 whole-file vault)",
    );
    expect(info).toContain("roles (2): common, webapp [argument_specs]");
    expect(info).toContain("requirements: requirements.yml (3 collections, 1 role)");
    expect(info).toMatch(
      /binaries: ansible-doc ansible-inventory ansible-playbook ansible-galaxy ansible-config ansible-lint 26\.10\.1/,
    );

    const doc = await call("ansible_module_doc", { name: "ufw" });
    expect(doc.split("\n")[0]).toBe(
      "community.general.ufw (module, community.general 9.5.2) [resolved from 'ufw'] - Manage firewall with UFW",
    );

    const search = await call("ansible_module_search", { query: "firewall", collection: "ansible.posix" });
    expect(search.split("\n")[1]).toBe("ansible.posix.firewalld - Manage arbitrary ports/services with firewalld");

    const checked = await call("ansible_check_task_args", { file: "playbooks/tasks/bad_args.yml" });
    expect(checked.split("\n")[0]).toBe(
      "playbooks/tasks/bad_args.yml: 7 tasks checked against installed docs (ansible-core 2.21.5): 5 problems in 3 tasks",
    );
    const one = await call("ansible_check_task_args", { file: "playbooks/tasks/bad_args.yml", line: 40 });
    expect(one).toMatch(/1 task checked .*\(task at line 40\): 1 problem in 1 task/);
    const inline = await call("ansible_check_task_args", {
      task: "ansible.builtin.copy:\n  dest: /x\n  content: y\n  colour: red\n",
    });
    expect(inline).toContain("    unknown option colour (line 4)");

    const role = await call("ansible_role_interface", { role: "webapp" });
    expect(role.split("\n")[0]).toBe("role webapp (local, roles/webapp): 2 entry points, 5 defaults, 1 dependency");
    const roleCall = calls.find((c) => c.tool === "ansible-doc" && c.args.includes("role"))!;
    expect(roleCall.args).toContain("-r");

    const inv = await call("ansible_inventory");
    expect(inv.split("\n").slice(0, 7)).toEqual([
      "inventory inventory/hosts.yml (ansible-core 2.21.5): 3 hosts, 5 groups",
      "@all:",
      "  @ungrouped:",
      "  @web: web1, web2",
      "  @db: db1",
      "  @staging:",
      "    @web",
    ]);
    expect(inv).toMatch(
      /^degraded: group_vars\/host_vars merged by Ansible are unavailable because inventory\/group_vars\/all\/vault\.yml is a whole-file vault/m,
    );
    expect(inv).toContain("    <vaulted file, not read>");

    const host = await call("ansible_inventory", { host: "web1" });
    expect(host.split("\n")[0]).toBe(
      "host web1 (inventory inventory/hosts.yml, ansible-core 2.21.5): groups all, staging, web",
    );
    expect(host).toContain("redacted: 2 vaulted, 1 by name, 1 URL password");
    expect(await call("ansible_inventory", { host: "nope" })).toBe("host 'nope' is not in this inventory");

    const pb = await call("ansible_playbook_structure", { playbook: "playbooks/site.yml" });
    const pbl = pb.split("\n");
    expect(pbl[0]).toBe(
      "playbook playbooks/site.yml (ansible-core 2.21.5): syntax ok, 3 plays, 15 tasks, hosts matched 3",
    );
    expect(pbl[1]).toBe("play 1 'Web tier' hosts=web (2: web1, web2) tags [web] roles: webapp (+ dependency common)");
    expect(pb).toContain("  common : Mount data [web] ansible.posix.mount roles/common/tasks/main.yml:7");
    expect(pb).toContain(
      "  webapp : Validating arguments against arg spec 'main' - Install and configure the web application [always, web] (inserted by Ansible)",
    );
    expect(pb).toContain(
      "  webapp : Configure [config, web] ansible.builtin.include_tasks roles/webapp/tasks/main.yml:20 [dynamic: configure.yml not expanded]",
    );
    expect(pb).toContain(
      "  webapp : OS specific [web] ansible.builtin.include_tasks roles/webapp/tasks/main.yml:24 [dynamic, templated name]",
    );
    expect(pb).toContain("  Git identity [db, git] community.general.git_config playbooks/site.yml:17");
    expect(pb).toContain("tags: always, config, db, git, packages, tuning, web");
    expect(pb).toMatch(/^ {2}playbooks\/site\.yml:31 community\.general\.consul_acl has been deprecated\./m);

    const cfg = await call("ansible_config");
    expect(cfg).toContain("  DEFAULT_FORKS = 7  (ansible.cfg)");

    const coll = await call("ansible_collections");
    expect(coll).toContain("  ansible.posix 2.0.0: installed 1.5.4 VIOLATES (requirements.yml:5)");
    expect(coll).toContain("summary: 1 ok, 1 violation, 2 missing");

    const lint = await call("ansible_lint_summary");
    expect(lint.split("\n")[0]).toBe("ansible-lint 26.10.1 (offline): 7 failures, 2 warnings in 19 files");

    // Every Ansible child except ansible-config dump got the safety environment.
    for (const c of calls.filter(
      (x) => !["ansible-config", "ansible"].includes(x.tool) && !x.args.includes("--version"),
    )) {
      expect(c.env.ANSIBLE_VAULT_PASSWORD_FILE, `${c.tool} ${c.args.join(" ")}`).toMatch(/[\\/]vault-null$/);
      expect(c.env.ANSIBLE_INVENTORY_ENABLED).toBe("host_list,yaml,ini,toml");
      expect(c.env.ANSIBLE_VAULT_ID_MATCH).toBeUndefined();
    }
    const dump = calls.find((c) => c.tool === "ansible-config")!;
    expect(dump.env.ANSIBLE_VAULT_PASSWORD_FILE).toBe(process.env.ANSIBLE_VAULT_PASSWORD_FILE);
  });

  it("refuses play-level lookups before spawning ansible-playbook or ansible-lint (R1)", async () => {
    const dir = fixtureCopy("hostile");
    const calls: Recorded[] = [];
    client = await connect({
      exec: LINUX,
      spawner: replaySpawner(routes(dir), calls),
      cacheDir: tempDir(),
      defaultDir: dir,
    });
    for (const name of ["ansible_playbook_structure", "ansible_lint_summary"]) {
      const res = await client.callTool({
        name,
        arguments: name === "ansible_playbook_structure" ? { playbook: "play.yml" } : {},
      });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toMatch(
        /has a lookup in 'hosts'; Ansible would run it on this machine while parsing\. Not run\./,
      );
      expect(textOf(res)).toMatch(/ANSIBLE_MCP_ALLOW_PLAY_LOOKUPS=1/);
    }
    expect(calls.filter((c) => c.tool === "ansible-playbook" || c.tool === "ansible-lint")).toEqual([]);
  });

  /** Replayed ansible.posix 2.0.0 install, target docs and target syntax-check. */
  function upgradeRoutes(cacheDir: string): Route[] {
    const tree = join(cacheDir, "collections", "ansible.posix", "2.0.0").replace(/\\/g, "/");
    const install: Route = {
      tool: "ansible-galaxy",
      has: ["install", "--no-deps"],
      stdout: (args) => {
        const p = args[args.indexOf("-p") + 1]!;
        const root = join(p, "ansible_collections", "ansible", "posix");
        mkdirSync(join(root, "meta"), { recursive: true });
        writeFileSync(
          join(root, "MANIFEST.json"),
          JSON.stringify({ collection_info: { version: "2.0.0", dependencies: {} } }),
        );
        cpSync(join(OUT, "upgrade", "posix-2.0.0-runtime.yml"), join(root, "meta", "runtime.yml"));
        return "ansible.posix:2.0.0 was installed successfully\n";
      },
    };
    const targetDocs: Route = {
      tool: "ansible-doc",
      has: ["--json"],
      when: (_a, env) => (env.ANSIBLE_COLLECTIONS_PATH ?? "").includes("ansible.posix"),
      stdout: (args) => {
        const all = JSON.parse(
          readOut("upgrade/docs-target.json").replaceAll("/tmp/ansible-mcp-work/targets/ansible.posix-2.0.0", tree),
        );
        const out: Record<string, unknown> = {};
        for (const a of args) if (all[a]) out[a] = all[a];
        return JSON.stringify(out);
      },
    };
    const targetSyntax: Route = {
      tool: "ansible-playbook",
      has: ["--syntax-check"],
      when: (_a, env) => (env.ANSIBLE_COLLECTIONS_PATH ?? "").includes("ansible.posix"),
      stdout: "\nplaybook: playbooks/site.yml\n",
    };
    return [install, targetDocs, targetSyntax];
  }

  /** Every Ansible child except ansible-config dump / --version probes got the safety env. */
  function expectSafetyEnv(calls: Recorded[]) {
    const safe = calls.filter((x) => !["ansible-config", "ansible"].includes(x.tool) && !x.args.includes("--version"));
    expect(safe.length).toBeGreaterThan(0);
    for (const c of safe) {
      expect(c.env.ANSIBLE_VAULT_PASSWORD_FILE, `${c.tool} ${c.args.join(" ")}`).toMatch(/[\\/]vault-null$/);
      expect(c.env.ANSIBLE_INVENTORY_ENABLED, `${c.tool} ${c.args.join(" ")}`).toBe("host_list,yaml,ini,toml");
      expect(c.env.ANSIBLE_VAULT_ID_MATCH, `${c.tool} ${c.args.join(" ")}`).toBeUndefined();
    }
  }

  it("ansible_upgrade_impact: downloads once into the cache, then answers from it", async () => {
    const dir = fixtureCopy("project");
    const cacheDir = tempDir();
    const calls: Recorded[] = [];
    client = await connect({
      exec: LINUX,
      spawner: replaySpawner(routes(dir, upgradeRoutes(cacheDir)), calls),
      cacheDir,
      defaultDir: dir,
    });
    const run = async () => {
      const res = await client!.callTool({
        name: "ansible_upgrade_impact",
        arguments: { collection: "ansible.posix", version: "2.0.0" },
      });
      expect(res.isError, textOf(res)).toBeFalsy();
      expect(textOf(res)).not.toMatch(SENTINELS);
      return textOf(res);
    };
    const first = await run();
    const lines = first.split("\n");
    expect(lines[0]).toMatch(/^upgrade ansible\.posix 1\.5\.4 -> 2\.0\.0 \(major\) for /);
    expect(lines[1]).toMatch(
      /^target: requires_ansible '>=2\.15\.0' ok \(ansible-core 2\.21\.5\); dependencies: none; downloaded \(cache: /,
    );
    expect(lines[2]).toBe(
      "constraints: requirements.yml:5 pins '2.0.0' (satisfied by the target; installed 1.5.4 violates it today)",
    );
    expect(first).toContain(
      "BEHAVIOR CHANGES (1):\n  roles/webapp/tasks/main.yml:13 ansible.posix.firewalld: offline not set; default null -> false",
    );
    expect(first).toContain(
      "INFO (1):\n  roles/webapp/tasks/main.yml:13 ansible.posix.firewalld: masquerade type str -> bool; value 'yes' still converts (line 17)",
    );
    expect(first).toContain("syntax-check with 2.0.0: ok");
    expect(lines.at(-1)).toBe("verdict: BEHAVIOR CHANGES (1)");
    const installs = () => calls.filter((c) => c.args.includes("install")).length;
    expect(installs()).toBe(1);
    const second = await run();
    expect(second).toMatch(/dependencies: none; cached \(cache: /);
    expect(installs()).toBe(1);

    // The install, the target-path ansible-doc and the target syntax-check all
    // ran under the safety env, like every other child.
    expectSafetyEnv(calls);
    expect(
      calls.some((c) => c.tool === "ansible-doc" && (c.env.ANSIBLE_COLLECTIONS_PATH ?? "").includes("ansible.posix")),
    ).toBe(true);
    expect(
      calls.some(
        (c) => c.tool === "ansible-playbook" && (c.env.ANSIBLE_COLLECTIONS_PATH ?? "").includes("ansible.posix"),
      ),
    ).toBe(true);
    // The install never forces, never reads requirements, never upgrades, and
    // lands in a `.tmp-*` dir under the cache.
    const inst = calls.find((c) => c.tool === "ansible-galaxy" && c.args.includes("install"))!;
    for (const f of ["--force", "--force-with-deps", "-r", "--requirements-file", "--upgrade", "-U"]) {
      expect(inst.args, f).not.toContain(f);
    }
    expect(inst.args).toContain("--no-deps");
    const dest = inst.args[inst.args.indexOf("-p") + 1]!.replace(/\\/g, "/");
    const base = join(cacheDir, "collections", "ansible.posix").replace(/\\/g, "/");
    expect(dest.startsWith(`${base}/.tmp-2.0.0-`)).toBe(true);

    const bad = await client.callTool({
      name: "ansible_upgrade_impact",
      arguments: { collection: "Community", version: "1" },
    });
    expect(textOf(bad)).toBe("collection must be namespace.name, e.g. community.general");
    const constraint = await client.callTool({
      name: "ansible_upgrade_impact",
      arguments: { collection: "ansible.posix", version: ">=2.0.0" },
    });
    expect(textOf(constraint)).toBe("version must be an exact version like 12.0.0, not a constraint");
    const same = await client.callTool({
      name: "ansible_upgrade_impact",
      arguments: { collection: "ansible.posix", version: "1.5.4" },
    });
    expect(textOf(same)).toMatch(/^ansible\.posix is already installed at 1\.5\.4/);
    const none = await client.callTool({
      name: "ansible_upgrade_impact",
      arguments: { collection: "community.docker", version: "4.0.0" },
    });
    expect(textOf(none)).toMatch(/^community\.docker is not installed in any collections path/);
  });

  it("ansible_upgrade_impact: replaces a stale cache entry (no or wrong MANIFEST.json) instead of failing forever", async () => {
    const dir = fixtureCopy("project");
    const cacheDir = tempDir();
    const calls: Recorded[] = [];
    const base = join(cacheDir, "collections", "ansible.posix");
    const target = join(base, "2.0.0");
    const manifest = join(target, "ansible_collections", "ansible", "posix", "MANIFEST.json");
    client = await connect({
      exec: LINUX,
      spawner: replaySpawner(routes(dir, upgradeRoutes(cacheDir)), calls),
      cacheDir,
      defaultDir: dir,
    });
    const run = async () => {
      const res = await client!.callTool({
        name: "ansible_upgrade_impact",
        arguments: { collection: "ansible.posix", version: "2.0.0" },
      });
      expect(res.isError, textOf(res)).toBeFalsy();
      return textOf(res);
    };
    const installs = () => calls.filter((c) => c.args.includes("install")).length;

    // A leftover dir without MANIFEST.json (e.g. a crashed manual copy).
    mkdirSync(join(target, "junk"), { recursive: true });
    expect(await run()).toMatch(/dependencies: none; downloaded \(cache: /);
    expect(JSON.parse(readFileSync(manifest, "utf8")).collection_info.version).toBe("2.0.0");
    expect(readdirSync(base)).toEqual(["2.0.0"]);
    expect(await run()).toMatch(/dependencies: none; cached \(cache: /);
    expect(installs()).toBe(1);

    // A tree whose MANIFEST.json names another version is never served as 2.0.0.
    writeFileSync(manifest, JSON.stringify({ collection_info: { version: "1.9.9", dependencies: {} } }));
    expect(await run()).toMatch(/dependencies: none; downloaded \(cache: /);
    expect(JSON.parse(readFileSync(manifest, "utf8")).collection_info.version).toBe("2.0.0");
    expect(readdirSync(base)).toEqual(["2.0.0"]);
    expect(installs()).toBe(2);
  });

  it("answers in plain text on native Windows without a prefix; static tools still work", async () => {
    const dir = fixtureCopy("project");
    const calls: Recorded[] = [];
    client = await connect({
      exec: { ...LINUX, platform: "win32" },
      spawner: replaySpawner([], calls),
      cacheDir: tempDir(),
      defaultDir: dir,
    });
    const info = await client.callTool({ name: "ansible_project_info", arguments: {} });
    expect(info.isError).toBeFalsy();
    expect(textOf(info)).toContain("roles (2): common, webapp [argument_specs]");
    expect(textOf(info)).toContain(NATIVE_WINDOWS_MESSAGE);
    const role = await client.callTool({ name: "ansible_role_interface", arguments: { role: "webapp" } });
    expect(textOf(role)).toMatch(/^role webapp \(local, roles\/webapp\): 2 entry points/);
    for (const name of ["ansible_inventory", "ansible_config", "ansible_collections"]) {
      const res = await client.callTool({ name, arguments: {} });
      expect(res.isError, name).toBeFalsy();
      expect(textOf(res)).toBe(NATIVE_WINDOWS_MESSAGE);
    }
    expect(calls).toEqual([]);
  });

  it("validates parameters with plain answers and refuses UNC dirs and option-like values", async () => {
    const dir = fixtureCopy("project");
    client = await connect({ exec: LINUX, spawner: replaySpawner(routes(dir)), cacheDir: tempDir(), defaultDir: dir });
    const t = async (name: string, args: Record<string, unknown>) =>
      textOf(await client!.callTool({ name, arguments: args }));
    expect(await t("ansible_module_doc", { name: "x", type: "nope" })).toMatch(/^type must be one of module, lookup/);
    expect(await t("ansible_module_doc", { name: "-x" })).toBe("name must not start with '-'");
    expect(await t("ansible_inventory", { host: "--list" })).toBe("host must not start with '-'");
    expect(await t("ansible_check_task_args", {})).toBe(
      "pass exactly one of task (YAML) or file (path relative to dir)",
    );
    expect(await t("ansible_lint_summary", { profile: "max" })).toMatch(/^profile must be one of/);
    const unc = await client.callTool({ name: "ansible_config", arguments: { dir: "\\\\evil\\share" } });
    expect(unc.isError).toBe(true);
    expect(textOf(unc)).toMatch(/UNC or device path/);
    const missing = await client.callTool({ name: "ansible_config", arguments: { dir: join(dir, "nope") } });
    expect(textOf(missing)).toMatch(/does not exist or is not a directory/);
  });
});

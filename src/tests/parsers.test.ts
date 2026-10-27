import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { classifyDocStderr, parseDocJson, renderModuleDoc } from "../ansibleDoc.js";
import {
  byCollection,
  checkRequirement,
  collectionPathKey,
  isSitePackages,
  parseCollectionList,
  parseRequirements,
  parseRoleList,
  renderCollections,
} from "../collections.js";
import { parseConfigDump, renderConfig, safetyFooter } from "../config.js";
import { compareVersions, satisfies } from "../constraints.js";
import { parseVersionOutput } from "../context.js";
import {
  graphStats,
  groupsOf,
  hostMissing,
  isVaultFailure,
  parseGraph,
  renderGraph,
  renderHostVars,
  renderVarsFilesFallback,
  skippedSources,
} from "../inventory.js";
import { parseCodeclimate, parseLintSummary, renderLint } from "../lint.js";
import { firstSentence, parseListOutput, parseStderrMessages, prescanPlaybook, prescanRefusal } from "../playbook.js";
import { detectProject, ProjectFiles } from "../project.js";
import { Redactor } from "../redact.js";
import { renderRole, roleSpecsFromDocJson, roleSpecsFromNode, yaml11Choices } from "../role.js";
import { parseYaml, toJS } from "../yaml.js";
import { cleanupTempDirs, HOSTILE, PROJECT, readOut, tempDir } from "./helpers.js";

const SENTINELS = /FIXTURE-SECRET|FIXTURE-plain/;

afterAll(cleanupTempDirs);

describe("ansible-doc parsing (F1, F2)", () => {
  it("keys by the name asked, resolves FQCN and collection from the doc", () => {
    const d = parseDocJson(readOut("doc/ufw-short-name.json")).get("ufw")!;
    expect(d.fqcn).toBe("community.general.ufw");
    expect(d.collection).toBe("community.general");
    expect(d.filename).toMatch(/community\/general\/plugins\/modules\/ufw\.py$/);
    expect(parseDocJson(readOut("doc/copy.json")).get("ansible.builtin.copy")!.hasAction).toBe(true);
  });

  it("classifies missing, redirect-to-missing and tombstones", () => {
    expect(classifyDocStderr(readOut("doc/missing.stderr")).missing).toEqual(["community.general.does_not_exist"]);
    const red = classifyDocStderr(readOut("upgrade/target-proxmox_kvm.stderr"));
    expect(red.missing).toEqual(["community.general.proxmox_kvm"]);
    expect(red.deprecations[0]!.text).toMatch(/moved to community\.proxmox/);
    const t = classifyDocStderr(readOut("upgrade/target-multi-with-tombstone.stderr")).tombstones;
    expect(t).toEqual([
      {
        name: "community.general.consul_acl",
        text: "Use community.general.consul_token and/or community.general.consul_policy instead.",
        collection: "community.general",
        version: "10.0.0",
      },
    ]);
  });

  it("renders a module doc with flags and the cross-option caveat", () => {
    const d = parseDocJson(readOut("doc/ufw-short-name.json")).get("ufw")!;
    const text = renderModuleDoc({
      doc: d,
      type: "module",
      asked: "ufw",
      source: "community.general 9.5.2",
      includeReturn: true,
      includeExamples: false,
      descriptionChars: 160,
      majorFloor: "9.0.0",
    });
    expect(text.split("\n")[0]).toBe(
      "community.general.ufw (module, community.general 9.5.2) [resolved from 'ufw'] - Manage firewall with UFW",
    );
    expect(text).toContain(
      "  proto (str) [choices: any|tcp|udp|ipv6|esp|ah|gre|igmp] [aliases: protocol] - TCP/IP protocol.",
    );
    expect(text).toContain("not in ansible-doc output: cross-option rules");
  });

  it("redacts documented option defaults by name and value shape, not only no_log", () => {
    const d = parseDocJson(
      JSON.stringify({
        "test.fake.svc": {
          doc: {
            module: "svc",
            collection: "test.fake",
            plugin_name: "test.fake.svc",
            options: {
              api_token: { type: "str", default: "FIXTURE-SECRET-docdefault" },
              note: { type: "str", default: "ghp_FIXTUREplainGithubToken000000000004" },
              port: { type: "int", default: 8200 },
            },
          },
        },
      }),
    ).get("test.fake.svc")!;
    const text = renderModuleDoc({
      doc: d,
      type: "module",
      asked: "test.fake.svc",
      source: "test.fake 1.0.0",
      includeReturn: false,
      includeExamples: false,
      descriptionChars: 160,
      majorFloor: null,
    });
    expect(text).toContain("  api_token (str) [default: (redacted: secret-like name)]");
    expect(text).toContain("  note (str) [default: (redacted: secret-like value)]");
    expect(text).toContain("  port (int) [default: 8200]");
    expect(text).not.toMatch(SENTINELS);
    expect(text).not.toContain("ghp_");
  });
});

describe("inventory (F6, F8, F9)", () => {
  const root = parseGraph(readOut("inventory/graph.txt"))!;

  it("parses --graph and walks group membership", () => {
    const { hosts, groups } = graphStats(root);
    expect([hosts.size, groups.size]).toEqual([3, 5]);
    expect(groupsOf(root, "web1")).toEqual(["all", "staging", "web"]);
    expect(renderGraph(root, 200)).toEqual([
      "@all:",
      "  @ungrouped:",
      "  @web: web1, web2",
      "  @db: db1",
      "  @staging:",
      "    @web",
    ]);
  });

  it("renders host vars redacted (design.md 7.6 host web1)", () => {
    const vars = JSON.parse(readOut("inventory/host-web1.json"));
    const red = new Redactor();
    for (const [k, v] of Object.entries(vars)) red.learn(v, [k]);
    const lines = renderHostVars(vars, red);
    expect(lines).toEqual([
      "  ansible_become_password = <vaulted>",
      '  ansible_host = "10.0.0.11"',
      '  ansible_user = "deploy"',
      "  api_token = (redacted: secret-like name)",
      '  app_env = "staging"',
      '  db_password = "{{ vault_db_password }}" (template, not rendered)',
      "  http_port = 8080",
      "  nginx_workers = 4",
      '  ntp_server = "pool.ntp.org"',
      '  smtp_url = "smtp://mailer:(redacted)@mail.example.com:587"',
      "  tls_key_passphrase = <vaulted>",
      "  token_ttl = 3600",
    ]);
    expect(red.footer()).toBe("redacted: 2 vaulted, 1 by name, 1 URL password");
  });

  it("never prints a sentinel from any inventory capture, even the decrypted one", () => {
    for (const f of [
      "inventory/list.json",
      "inventory/list-WITH-vault-password.json",
      "never-execute/inventory-dynamic-enabled.json",
    ]) {
      const hv = JSON.parse(readOut(f))._meta.hostvars as Record<string, Record<string, unknown>>;
      const red = new Redactor();
      for (const v of Object.values(hv)) for (const [k, x] of Object.entries(v)) red.learn(x, [k]);
      const text = Object.values(hv)
        .flatMap((v) => renderHostVars(v, red))
        .join("\n");
      expect(text, f).not.toMatch(SENTINELS);
    }
  });

  it("detects vault failures, missing hosts and skipped dynamic sources", () => {
    expect(isVaultFailure(readOut("inventory/list-no-vault-secret.stderr"))).toBe(true);
    expect(isVaultFailure(readOut("inventory/list-wrong-vault-password.stderr"))).toBe(true);
    expect(hostMissing(readOut("inventory/host-missing.stderr"))).toBe(true);
    expect(skippedSources(readOut("never-execute/inventory-dynamic-disabled.stderr"))).toEqual([
      "/tmp/ansible-mcp-work/hostile/inventory/inv.sh",
      "/tmp/ansible-mcp-work/hostile/inventory/zz_constructed.yml",
    ]);
  });

  it("falls back to a per-file view that never reads a whole-file vault", () => {
    const files = new ProjectFiles(PROJECT);
    const red = new Redactor();
    const fb = renderVarsFilesFallback(
      [{ base: join(PROJECT, "inventory"), label: "inventory" }],
      (a) => files.rel(a),
      red,
    );
    expect(fb.vaulted).toEqual(["inventory/group_vars/all/vault.yml"]);
    const text = fb.lines.join("\n");
    expect(text).toContain("  inventory/group_vars/all/vault.yml (group_vars all):\n    <vaulted file, not read>");
    expect(text).toContain("    tls_key_passphrase = <vaulted>");
    expect(text).toContain("    deploy_key_note = (redacted: secret-like value)");
    expect(text).not.toMatch(SENTINELS);
  });
});

describe("playbook listing and stderr (F13, F14, F16)", () => {
  it("parses --list-hosts --list-tasks --list-tags in one run", () => {
    const plays = parseListOutput(readOut("playbook/list-all.txt"));
    expect(plays.map((p) => [p.index, p.pattern, p.name, p.hostCount, p.tasks.length])).toEqual([
      [1, "web", "Web tier", 2, 8],
      [2, "db", "Database tier", 1, 6],
      [3, "all", "All hosts", 3, 1],
    ]);
    expect(plays[0]!.tasks[2]).toEqual({
      role: "webapp",
      name: "Validating arguments against arg spec 'main' - Install and configure the web application",
      tags: ["always", "web"],
    });
    expect(plays[0]!.taskTags).toEqual(["always", "config", "packages", "web"]);
    expect(parseListOutput(readOut("never-execute/list-tasks.txt"))[0]!.tasks[0]!.name).toMatch(/^Task \{\{ lookup/);
  });

  it("reads [ERROR] and [DEPRECATION WARNING] with their Origin", () => {
    const m = parseStderrMessages(readOut("upgrade/target-syntax-check.stderr"));
    const err = m.find((x) => x.kind === "ERROR")!;
    expect(err.origin).toEqual({ file: "/tmp/ansible-mcp-work/project/playbooks/site.yml", line: 22, col: 7 });
    expect(firstSentence(err.text)).toBe("couldn't resolve module/action 'community.general.proxmox_kvm'");
    const dep = parseStderrMessages(readOut("playbook/syntax-check.stderr")).find(
      (x) => x.kind === "DEPRECATION WARNING",
    )!;
    expect(dep.origin?.line).toBe(31);
  });

  it("refuses the hostile playbook's play-level lookups before Ansible sees them (R1)", () => {
    const hits = prescanPlaybook(new ProjectFiles(HOSTILE), "play.yml");
    expect(hits.map((h) => h.field)).toEqual(["name", "hosts", "vars_files"]);
    expect(prescanRefusal(hits)).toMatch(
      /^play\.yml:1 play 'Play \{\{ lookup.*has a lookup in 'name'; Ansible would run it on this machine while parsing\. Not run\.$/m,
    );
    expect(prescanPlaybook(new ProjectFiles(PROJECT), "playbooks/site.yml")).toEqual([]);
  });
});

describe("config (F11)", () => {
  it("renders origins and flags nothing for the plain project", () => {
    const d = parseConfigDump(readOut("config/only-changed.json"));
    const text = renderConfig(d, {
      dirLabel: "<dir>",
      coreVersion: "2.21.5",
      all: false,
      limit: 300,
      display: (s) => s.replace("/tmp/ansible-mcp-work/project/", ""),
    });
    expect(text).toContain("effective config for <dir> (ansible-core 2.21.5): config file ansible.cfg");
    expect(text).toContain("  DEFAULT_FORKS = 7  (ansible.cfg)");
    expect(text).toContain('  DEFAULT_ROLES_PATH = ["roles"]  (ansible.cfg)');
    expect(text).toContain("galaxy servers: (none configured)");
    expect(safetyFooter(d, false)).toBe("");
  });

  it("always redacts galaxy credentials and flags overridden settings", () => {
    const d = parseConfigDump(readOut("config/galaxy-servers.json"));
    const text = renderConfig(d, { dirLabel: "d", coreVersion: "2.21.5", all: false, limit: 300, display: (s) => s });
    expect(text).not.toMatch(SENTINELS);
    expect(text).toContain(
      "  hub: url=https://hub.example.com/api/galaxy/content/published/ token=(redacted: galaxy credential) timeout=60",
    );
    expect(text).toContain("password=(redacted: galaxy credential)");
    expect(text).toMatch(/DEFAULT_VAULT_PASSWORD_FILE = .*\[overridden by ansible-mcp in other tools\]/);
    expect(safetyFooter(d, false)).toMatch(
      /^safety: vault_password_file from env: ANSIBLE_VAULT_PASSWORD_FILE ignored/,
    );
  });
});

describe("collections (F12)", () => {
  const files = new ProjectFiles(PROJECT);
  const reqs = parseRequirements(files.read(join(PROJECT, "requirements.yml"))?.root, "requirements.yml");

  it("matches design.md 7.9 for the fixture", () => {
    const text = renderCollections({
      reqFiles: [{ file: "requirements.yml", reqs }],
      installed: byCollection(parseCollectionList(readOut("galaxy/collection-list.json")), [
        "/tmp/ansible-mcp-work/collections",
      ]),
      roles: parseRoleList(readOut("galaxy/role-list.txt")),
      collectionsPaths: ["/tmp/ansible-mcp-work/collections"],
      includeExtras: false,
      display: (s) => s,
    });
    expect(text.split("\n")).toEqual([
      "requirements.yml: 3 collections, 1 role (collections paths: /tmp/ansible-mcp-work/collections)",
      "collections:",
      "  community.general >=9.0.0,<10.0.0: installed 9.5.2 ok",
      "  ansible.posix 2.0.0: installed 1.5.4 VIOLATES (requirements.yml:5)",
      "  community.docker >=3.0.0: MISSING (requirements.yml:7)",
      "roles:",
      "  geerlingguy.ntp 2.3.1: MISSING (requirements.yml:10)",
      "shadowed: (none)",
      "summary: 1 ok, 1 violation, 2 missing",
    ]);
  });

  it("orders shadowed copies by COLLECTIONS_PATHS, not by print order", () => {
    const paths = [
      "/tmp/ansible-mcp-work/targets/community.general-12.0.0",
      "/tmp/ansible-mcp-work/targets/ansible.posix-2.0.0",
      "/tmp/ansible-mcp-work/collections",
    ];
    const m = byCollection(parseCollectionList(readOut("galaxy/collection-list-shadowed.json")), paths);
    expect(m.get("ansible.posix")!.map((i) => i.version)).toEqual(["2.0.0", "1.5.4"]);
    expect(m.get("community.general")!.map((i) => i.version)).toEqual(["12.0.0", "9.5.2"]);
  });

  it("ranks shadowed copies whatever the path separator or form (native Windows, WSL, UNC)", () => {
    const list = (paths: Record<string, string>) =>
      parseCollectionList(
        JSON.stringify(
          Object.fromEntries(Object.entries(paths).map(([p, v]) => [p, { "ansible.posix": { version: v } }])),
        ),
      );
    // Native Windows: backslashes, a trailing separator and drive-letter case in COLLECTIONS_PATHS.
    const win = byCollection(
      list({ "C:\\Users\\me\\site\\ansible_collections": "1.5.4", "D:\\ws\\colls\\ansible_collections": "2.0.0" }),
      ["d:/ws/colls/", "C:\\Users\\me\\site"],
    );
    expect(win.get("ansible.posix")!.map((i) => i.version)).toEqual(["2.0.0", "1.5.4"]);
    // A drive path and its WSL translation are the same place; a custom mount root too.
    const wsl = byCollection(
      list({ "/mnt/c/a/ansible_collections": "1.5.4", "/opt/x/ansible_collections/": "2.0.0" }),
      ["/opt/x", "C:\\a"],
    );
    expect(wsl.get("ansible.posix")!.map((i) => i.version)).toEqual(["2.0.0", "1.5.4"]);
    const custom = byCollection(
      list({ "/opt/x/ansible_collections": "2.0.0", "/win/c/a/ansible_collections": "1.5.4" }),
      ["C:/a", "/opt/x"],
      "/win/",
    );
    expect(custom.get("ansible.posix")!.map((i) => i.version)).toEqual(["1.5.4", "2.0.0"]);
    // A \\wsl.localhost UNC path is its Linux path; a configured path may itself end in ansible_collections.
    const unc = byCollection(
      list({ "/home/u/a/ansible_collections": "1.5.4", "/tmp/b/ansible_collections": "2.0.0" }),
      ["/tmp/b/ansible_collections", "\\\\wsl.localhost\\Ubuntu\\home\\u\\a"],
    );
    expect(unc.get("ansible.posix")!.map((i) => i.version)).toEqual(["2.0.0", "1.5.4"]);
    // Linux paths stay case-sensitive.
    expect(collectionPathKey("/Opt/X")).not.toBe(collectionPathKey("/opt/x"));
    expect(collectionPathKey("C:\\A\\ansible_collections\\")).toBe(collectionPathKey("/mnt/c/a"));
  });

  it("detects the ansible package's bundle with any separator, site- or dist-packages", () => {
    for (const p of [
      "/usr/lib/python3/site-packages/ansible_collections",
      "/usr/lib/python3/dist-packages/ansible_collections",
      "C:\\Python312\\Lib\\site-packages\\ansible_collections",
      "C:\\Python312\\Lib\\site-packages\\ansible_collections\\",
    ])
      expect(isSitePackages(p), p).toBe(true);
    expect(isSitePackages("/home/u/.ansible/collections/ansible_collections")).toBe(false);
    expect(isSitePackages("/srv/my-site-packages/ansible_collections")).toBe(false);
    const text = renderCollections({
      reqFiles: [],
      installed: byCollection(
        parseCollectionList(
          JSON.stringify({
            "C:\\Py\\Lib\\site-packages\\ansible_collections": { "amazon.aws": { version: "9.0.0" } },
            "/usr/lib/python3/dist-packages/ansible_collections": { "cisco.ios": { version: "9.0.0" } },
            "C:\\me\\colls\\ansible_collections": { "my.own": { version: "1.0.0" } },
          }),
        ),
        ["C:\\me\\colls"],
      ),
      roles: [],
      collectionsPaths: ["C:\\me\\colls"],
      includeExtras: true,
      display: (s) => s,
    });
    expect(text).toContain("installed, not required (1):\n  my.own 1.0.0");
    expect(text).toContain("2 collections from the ansible package (site-packages)");
  });

  it("dedupes role list blocks and evaluates galaxy constraints", () => {
    expect(parseRoleList(readOut("galaxy/role-list.txt")).map((r) => r.name)).toEqual(["common", "webapp"]);
    expect(satisfies("9.5.2", ">=9.0.0,<10.0.0")).toBe(true);
    expect(satisfies("12.0.0", ">=9.0.0,<10.0.0")).toBe(false);
    expect(satisfies("1.0.0", "*")).toBe(true);
    expect(satisfies("2.0.0", "!=2.0.0")).toBe(false);
    expect(satisfies("2.0.0-beta1", ">=1.0.0")).toBe(false);
    expect(satisfies("2.0.0-beta1", ">=2.0.0-beta1")).toBe(true);
    expect(satisfies("2.21.5", ">=2.17.0")).toBe(true);
    expect(checkRequirement({ name: "x", version: "1.0.0", type: "git", line: 1, file: "r" }, "1.0.0")).toEqual({
      kind: "unchecked",
      why: "type git",
    });
  });
});

describe("ansible-lint (F17)", () => {
  it("groups codeclimate issues by rule with both location shapes", () => {
    const issues = parseCodeclimate(readOut("lint/project.codeclimate.json"));
    expect(issues).toHaveLength(9);
    const text = renderLint("26.10.1", issues, readOut("lint/project.stderr"), 5);
    const lines = text.split("\n");
    expect(lines[0]).toBe("ansible-lint 26.10.1 (offline): 7 failures, 2 warnings in 19 files");
    expect(lines[1]).toBe("fqcn[action] x3 (failure, formatting) - Use FQCN for module actions");
    expect(lines[2]).toBe(
      "  playbooks/tasks/bad_args.yml:38, roles/common/tasks/main.yml:7, roles/webapp/tasks/main.yml:10",
    );
    expect(text).toContain("args[module] x2 (warning, syntax/experimental)");
    expect(text).toContain(
      "lint warnings (not violations): inventory/group_vars/all/vault.yml could not be decrypted (expected: no vault secrets)",
    );
    expect(parseLintSummary(readOut("lint/project.stderr"))).toEqual({ failures: 7, warnings: 2, files: 19 });
  });
});

describe("roles (F5)", () => {
  const files = new ProjectFiles(PROJECT);
  const specFile = join(PROJECT, "roles", "webapp", "meta", "argument_specs.yml");

  it("renders the webapp interface from ansible-doc and from the file identically", () => {
    const fromDoc = roleSpecsFromDocJson(readOut("doc/role-webapp.json"), "webapp")!.specs;
    const root = files.read(specFile)!.root;
    const fromFile = roleSpecsFromNode(root)!;
    const render = (specs: typeof fromDoc) =>
      renderRole({
        name: "webapp",
        origin: "local, roles/webapp",
        specs,
        specsSource: "x",
        roleDir: join(PROJECT, "roles", "webapp"),
        files,
        descriptionChars: 160,
        yaml11: yaml11Choices(root),
      });
    const a = render(fromDoc);
    expect(render(fromFile)).toBe(a);
    const lines = a.split("\n");
    expect(lines[0]).toBe("role webapp (local, roles/webapp): 2 entry points, 5 defaults, 1 dependency");
    expect(a).toContain("  webapp_server_name (str) [required] - Public DNS name.");
    expect(a).toContain(
      '  webapp_tls_mode (str) [default: "self_signed"] [choices: false|self_signed|acme] - How the certificate is obtained.',
    );
    expect(a).toContain(
      "    WARNING choice false comes from unquoted 'off' in meta/argument_specs.yml (YAML 1.1); quote it",
    );
    expect(a).toContain("  webapp_admin_password = (no_log)");
    expect(a).toContain('  webapp_packages = ["nginx","python3-venv"]');
    expect(a).toContain("  [not in argument_specs: webapp_packages]");
    expect(a).toContain("dependencies: common (vars: common_timezone)");
    expect(a).toContain("    host (str) [required]");
    expect(a).not.toMatch(SENTINELS);
  });

  it("redacts argument_spec defaults by name and value shape, and feeds them to layer 2", () => {
    const root = tempDir();
    const roleDir = join(root, "roles", "svc");
    mkdirSync(join(roleDir, "defaults"), { recursive: true });
    writeFileSync(join(roleDir, "defaults", "main.yml"), "svc_note: FIXTURE-SECRET-specdefault\n");
    const text = renderRole({
      name: "svc",
      origin: "local, roles/svc",
      specs: {
        main: {
          options: {
            api_token: { type: "str", default: "FIXTURE-SECRET-specdefault" },
            note: { type: "str", default: "ghp_FIXTUREplainGithubToken000000000004" },
            tls_mode: { type: "str", default: "self_signed" },
          },
        },
      },
      specsSource: "x",
      roleDir,
      files: new ProjectFiles(root),
      descriptionChars: 160,
      yaml11: [],
    });
    expect(text).toContain("  api_token (str) [default: (redacted: secret-like name)]");
    // The same value under an innocent defaults key is caught by layer 2.
    expect(text).toContain("  svc_note = (redacted: contains a secret value)");
    expect(text).toContain("  note (str) [default: (redacted: secret-like value)]");
    expect(text).toContain('  tls_mode (str) [default: "self_signed"]');
    expect(text).not.toMatch(SENTINELS);
    expect(text).not.toContain("ghp_");
  });
});

describe("YAML 1.1 reader (F5)", () => {
  it("agrees with PyYAML on booleans, octal and plain y/n", () => {
    const v = parseYaml("a: off\nb: yes\nc: 0755\nd: y\ne: n\nf: '0755'\n").root as any;
    const get = (k: string) => v.entries.find((e: any) => e.key === k).value.value;
    expect([get("a"), get("b"), get("c"), get("d"), get("e"), get("f")]).toEqual([false, true, 493, "y", "n", "0755"]);
  });

  it("keeps vault tags opaque and reports duplicate keys", () => {
    const d = parseYaml("x: !vault |\n  $ANSIBLE_VAULT;1.1;AES256\n  3031\nx: 2\n");
    expect(d.duplicates).toEqual([{ key: "x", line: 4 }]);
    const first = (d.root as any).entries[0].value;
    expect(first.value).toEqual({ __ansible_vault: "$ANSIBLE_VAULT;1.1;AES256\n3031\n" });
  });

  it("expands `<<:` merge keys the way PyYAML does, with own keys winning", () => {
    const v = toJS(
      parseYaml("d: &d\n  state: enabled\n  port: 80\nt:\n  ufw:\n    <<: *d\n    port: 22\n").root,
    ) as any;
    expect(v.t.ufw).toEqual({ state: "enabled", port: 22 });
  });

  it("follows a chained merge and survives a self-referential one", () => {
    const chained = toJS(parseYaml("a: &a\n  x: 1\nb: &b\n  <<: *a\n  y: 2\nt:\n  <<: *b\n  z: 3\n").root) as any;
    expect(chained.t).toEqual({ x: 1, y: 2, z: 3 });
    // `<<: *self` must not recurse forever.
    expect(() => toJS(parseYaml("a: &a\n  <<: *a\n  x: 1\n").root)).not.toThrow();
  });

  it("reports a merge anchor's duplicate key once, not once per use", () => {
    const d = parseYaml("d: &d\n  x: 1\n  x: 2\nt:\n  <<: *d\n  y: 3\n");
    expect(d.duplicates).toEqual([{ key: "x", line: 3 }]);
  });
});

describe("version constraints (F12)", () => {
  it("orders prerelease segments numerically, not lexically (rc2 < rc10)", () => {
    expect(compareVersions("1.0.0-rc2", "1.0.0-rc10")).toBe(-1);
    expect(compareVersions("1.0.0-rc10", "1.0.0-rc2")).toBe(1);
  });

  it("lets a prerelease satisfy `*` (no bound excludes it)", () => {
    expect(satisfies("2.0.0rc1", "*")).toBe(true);
    expect(satisfies("2.0.0rc1", ">=2.0.0")).toBe(false);
  });
});

describe("project detection and version parsing", () => {
  it("detects the fixture project's parts", () => {
    const det = detectProject(PROJECT, ["inventory/hosts.yml"]);
    expect(det.playbooks).toEqual([{ rel: "playbooks/site.yml", plays: 3 }]);
    expect(det.inventories).toEqual([{ rel: "inventory/hosts.yml", kind: "yaml, from ansible.cfg" }]);
    expect(det.roles).toEqual([
      { name: "common", rel: "roles/common", argumentSpecs: false },
      { name: "webapp", rel: "roles/webapp", argumentSpecs: true },
    ]);
    expect(det.requirements).toEqual(["requirements.yml"]);
  });

  it("parses ansible --version", () => {
    const v = parseVersionOutput(readOut("version.txt"));
    expect(v).toMatchObject({ core: "2.21.5", python: "3.12.14", jinja: "3.1.6" });
  });
});

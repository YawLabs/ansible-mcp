import { describe, expect, it } from "vitest";
import { type PluginDoc, parseDocJson } from "../ansibleDoc.js";
import { docNamesFor, resolveTaskDoc } from "../checkArgs.js";
import { ProjectFiles, walkPlaybooks } from "../project.js";
import {
  constraintLines,
  diffModuleUsage,
  ensureTarget,
  type Finding,
  mapGalaxyError,
  parseRuntime,
  renderUpgrade,
  routingFor,
  type UsedModule,
} from "../upgrade.js";
import { docResult, PROJECT, readOut } from "./helpers.js";

const files = new ProjectFiles(PROJECT);
const walk = walkPlaybooks(files, ["playbooks/site.yml"], { rolesPaths: [] });
const installed = docResult(docNamesFor(walk.tasks));
const targetDocs = parseDocJson(readOut("upgrade/docs-target.json"));

function used(collection: string): UsedModule[] {
  const out: UsedModule[] = [];
  for (const t of walk.tasks) {
    const r = resolveTaskDoc(t, installed);
    if (r?.kind === "doc" && r.doc.fqcn.startsWith(`${collection}.`))
      out.push({ task: t, fqcn: r.doc.fqcn, installedDoc: r.doc });
  }
  return out;
}

function findings(collection: string, targetRuntimeFile: string, installedRuntimeFile: string): Finding[] {
  const trt = parseRuntime(readOut(targetRuntimeFile));
  const irt = parseRuntime(readOut(installedRuntimeFile));
  return used(collection).flatMap((u) => {
    const routing = routingFor(trt, "module", u.fqcn, collection);
    const targetDoc: PluginDoc | undefined = targetDocs.get(u.fqcn);
    return diffModuleUsage({
      used: u,
      collection,
      targetDoc,
      targetRouting: routing,
      installedRouting: routingFor(irt, "module", u.fqcn, collection),
      redirectResolved: routing?.redirect ? null : undefined,
    });
  });
}

const fmt = (f: Finding) => `${f.severity} ${f.file}:${f.line} ${f.subject}: ${f.text}`;

describe("ansible_upgrade_impact rules on the real 9.5.2 -> 12.0.0 and 1.5.4 -> 2.0.0 docs (design.md 6.6)", () => {
  it("walks the playbook through roles, role dependencies and short names", () => {
    const uses = used("community.general").map((u) => `${u.task.file}:${u.task.line} ${u.fqcn}`);
    expect(uses).toEqual([
      "roles/common/tasks/main.yml:3 community.general.timezone",
      "roles/webapp/tasks/main.yml:10 community.general.ufw",
      "playbooks/site.yml:17 community.general.git_config",
      "playbooks/site.yml:23 community.general.proxmox_kvm",
      "playbooks/site.yml:31 community.general.consul_acl",
      "playbooks/site.yml:37 community.general.slack",
      "playbooks/site.yml:43 community.general.rhsm_repository",
    ]);
    expect(walk.notFollowed).toEqual([
      'roles/webapp/tasks/main.yml:24 include_tasks "{{ ansible_os_family | lower }}.yml"',
    ]);
  });

  it("community.general 9.5.2 -> 12.0.0: five breaking findings and one behavior change", () => {
    const f = findings(
      "community.general",
      "upgrade/cg-12.0.0-runtime-excerpt.yml",
      "upgrade/cg-9.5.2-runtime-excerpt.yml",
    );
    expect(f.map(fmt).sort()).toEqual(
      [
        "BREAKING playbooks/site.yml:17 community.general.git_config: option list_all removed (line 19)",
        "BREAKING playbooks/site.yml:17 community.general.git_config: name is newly required, not set",
        "BREAKING playbooks/site.yml:23 community.general.proxmox_kvm: moved to community.proxmox.proxmox_kvm; community.proxmox is not installed (add it to requirements.yml)",
        "BREAKING playbooks/site.yml:31 community.general.consul_acl: removed in 10.0.0 (tombstone): Use community.general.consul_token and/or community.general.consul_policy instead.",
        "BREAKING playbooks/site.yml:43 community.general.rhsm_repository: state=present no longer accepted (choices: enabled, disabled) (line 45)",
        "BEHAVIOR CHANGE playbooks/site.yml:37 community.general.slack: prepend_hash not set; default 'auto' -> 'never'",
      ].sort(),
    );
  });

  it("ansible.posix 1.5.4 -> 2.0.0: one behavior change and one info", () => {
    const f = findings("ansible.posix", "upgrade/posix-2.0.0-runtime.yml", "upgrade/posix-1.5.4-runtime.yml");
    expect(f.map(fmt).sort()).toEqual([
      "BEHAVIOR CHANGE roles/webapp/tasks/main.yml:13 ansible.posix.firewalld: offline not set; default null -> false",
      "INFO roles/webapp/tasks/main.yml:13 ansible.posix.firewalld: masquerade type str -> bool; value 'yes' still converts (line 17)",
    ]);
  });

  it("renders the report with a verdict", () => {
    const f = findings(
      "community.general",
      "upgrade/cg-12.0.0-runtime-excerpt.yml",
      "upgrade/cg-9.5.2-runtime-excerpt.yml",
    );
    const text = renderUpgrade({
      collection: "community.general",
      installedVersion: "9.5.2",
      targetVersion: "12.0.0",
      dirLabel: "<dir>",
      core: "2.21.5",
      requiresAnsible: ">=2.17.0",
      requiresOk: true,
      dependencies: [],
      cacheNote: "cached (cache: /c)",
      constraints: constraintLines(
        [{ file: "requirements.yml", text: readOut("../project/requirements.yml") }],
        "community.general",
        "9.5.2",
        "12.0.0",
      ),
      used: used("community.general"),
      playbookFiles: new Set(["playbooks/site.yml"]),
      findings: f,
      notFollowed: [],
      syntax: [],
      unused: [],
      warnings: [],
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("upgrade community.general 9.5.2 -> 12.0.0 (major) for <dir>");
    expect(lines[1]).toBe(
      "target: requires_ansible '>=2.17.0' ok (ansible-core 2.21.5); dependencies: none; cached (cache: /c)",
    );
    expect(lines[2]).toBe("constraints: requirements.yml:3 pins '>=9.0.0,<10.0.0' (change it to allow 12.0.0)");
    expect(lines[3]).toBe(
      "used modules (7): git_config, proxmox_kvm, consul_acl, slack, rhsm_repository (playbooks/site.yml); timezone (roles/common/tasks/main.yml); ufw (roles/webapp/tasks/main.yml, via short name ufw)",
    );
    expect(lines).toContain("BREAKING (5):");
    expect(
      lines.indexOf("  playbooks/site.yml:17 community.general.git_config: option list_all removed (line 19)"),
    ).toBeLessThan(
      lines.indexOf("  playbooks/site.yml:17 community.general.git_config: name is newly required, not set"),
    );
    expect(lines).toContain("BEHAVIOR CHANGES (1):");
    expect(lines.at(-1)).toBe("verdict: BREAKING (5)");
  });

  it("covers the unit-only rules: alias dropped, removed without routing, redirect resolved, non-convertible type", () => {
    const mk = (options: Record<string, unknown>, fqcn = "x.y.mod"): PluginDoc =>
      parseDocJson(
        JSON.stringify({
          [fqcn]: {
            doc: {
              plugin_name: fqcn,
              collection: "x.y",
              filename: `/t/ansible_collections/x/y/plugins/modules/mod.py`,
              options,
            },
          },
        }),
      ).get(fqcn)!;
    const task = (args: { name: string; value: unknown }[]) => ({
      task: {
        file: "a.yml",
        line: 5,
        startLine: 4,
        endLine: 9,
        args: args.map((a) => ({ ...a, line: 6 })),
        form: "dict",
        collections: [],
        duplicates: [],
        pluginRefs: [],
      } as any,
      fqcn: "x.y.mod",
    });
    const inst = mk({ path: { aliases: ["dest"] }, size: { type: "str" } });
    const targ = mk({ path: {}, size: { type: "int" } });
    const f1 = diffModuleUsage({
      used: {
        ...task([
          { name: "dest", value: "/a" },
          { name: "size", value: "big" },
        ]),
        installedDoc: inst,
      },
      collection: "x.y",
      targetDoc: targ,
    });
    expect(f1.map((f) => `${f.severity} ${f.text}`)).toEqual([
      "BREAKING alias dest dropped; use path (line 6)",
      "BREAKING size type str -> int; value 'big' does not convert (line 6)",
    ]);
    const f2 = diffModuleUsage({ used: { ...task([]), installedDoc: inst }, collection: "x.y" });
    expect(f2.map((f) => f.text)).toEqual(["removed (not in the target version, and no routing explains it)"]);
    const f3 = diffModuleUsage({
      used: { ...task([]), installedDoc: inst },
      collection: "x.y",
      targetRouting: { redirect: "z.w.mod" },
      redirectResolved: { fqcn: "z.w.mod", version: "1.2.3" },
    });
    expect(f3.map((f) => `${f.severity} ${f.text}`)).toEqual([
      "WARNING moved to z.w.mod (installed 1.2.3); update the task to the new name",
    ]);
  });

  it("never echoes a secret-shaped or no_log task value (design.md 5)", () => {
    const mk = (options: Record<string, unknown>, fqcn = "x.y.mod"): PluginDoc =>
      parseDocJson(
        JSON.stringify({
          [fqcn]: {
            doc: {
              plugin_name: fqcn,
              collection: "x.y",
              filename: "/t/ansible_collections/x/y/plugins/modules/mod.py",
              options,
            },
          },
        }),
      ).get(fqcn)!;
    const task = (args: { name: string; value: unknown }[]) => ({
      task: {
        file: "a.yml",
        line: 5,
        startLine: 4,
        endLine: 9,
        args: args.map((a) => ({ ...a, line: 6 })),
        form: "dict",
        collections: [],
        duplicates: [],
        pluginRefs: [],
      } as any,
      fqcn: "x.y.mod",
    });
    // A secret-shaped literal that leaves the target choices must not print.
    const SECRET = "sk-abcdefghijklmnopqrstuvwx";
    const inst = mk({ value: { choices: [SECRET], type: "str" } });
    const targ = mk({ value: { choices: ["other"], type: "str" } });
    const f = diffModuleUsage({
      used: { ...task([{ name: "value", value: SECRET }]), installedDoc: inst },
      collection: "x.y",
      targetDoc: targ,
    });
    const text = f.map((x) => x.text).join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).toContain("value=a value no longer accepted");
    // A `no_log` option's value is never echoed either: a neutral name (not
    // secret-like) and a value the installed choices accept, so the finding
    // exists and only no_log keeps the value out of it.
    const inst2 = mk({ mode: { type: "str", choices: ["hunter2", "new"], no_log: true } });
    const targ2 = mk({ mode: { type: "str", choices: ["new"], no_log: true } });
    const f2 = diffModuleUsage({
      used: { ...task([{ name: "mode", value: "hunter2" }]), installedDoc: inst2 },
      collection: "x.y",
      targetDoc: targ2,
    });
    const text2 = f2.map((x) => x.text).join("\n");
    expect(text2).toContain("no longer accepted");
    expect(text2).not.toContain("hunter2");
  });

  it("redacts documented defaults in BEHAVIOR CHANGE lines: no_log and secret-shaped values (design.md 5)", () => {
    const mk = (options: Record<string, unknown>): PluginDoc =>
      parseDocJson(
        JSON.stringify({
          "x.y.mod": {
            doc: {
              plugin_name: "x.y.mod",
              collection: "x.y",
              filename: "/t/ansible_collections/x/y/plugins/modules/mod.py",
              options,
            },
          },
        }),
      ).get("x.y.mod")!;
    const SHAPE = "sk-abcdefghijklmnopqrstuvwx";
    const inst = mk({
      endpoint: { type: "str", default: "https://api.example.com" },
      mode: { type: "str", default: "hunter2-old" },
      plain: { type: "str", default: "auto" },
    });
    const targ = mk({
      endpoint: { type: "str", default: SHAPE },
      mode: { type: "str", default: "hunter2-new", no_log: true },
      plain: { type: "str", default: "never" },
    });
    const f = diffModuleUsage({
      used: {
        task: {
          file: "a.yml",
          line: 5,
          startLine: 4,
          endLine: 9,
          args: [],
          form: "dict",
          collections: [],
          duplicates: [],
          pluginRefs: [],
        } as any,
        fqcn: "x.y.mod",
        installedDoc: inst,
      },
      collection: "x.y",
      targetDoc: targ,
    });
    const lines = f.map((x) => x.text);
    expect(lines).toEqual([
      "endpoint not set; default 'https://api.example.com' -> (redacted: secret-like value)",
      "mode not set; default (no_log) -> (no_log)",
      "plain not set; default 'auto' -> 'never'",
    ]);
    const text = lines.join("\n");
    expect(text).not.toContain(SHAPE);
    expect(text).not.toContain("hunter2");
  });

  it("BLOCKED when requires_ansible excludes the installed core", () => {
    const text = renderUpgrade({
      collection: "x.y",
      installedVersion: "1.0.0",
      targetVersion: "2.0.0",
      dirLabel: "d",
      core: "2.14.0",
      requiresAnsible: ">=2.17.0",
      requiresOk: false,
      dependencies: [],
      cacheNote: "cached",
      constraints: [],
      used: [],
      playbookFiles: new Set(),
      findings: [],
      notFollowed: [],
      syntax: [],
      unused: [],
      warnings: [],
    });
    expect(text).toMatch(/verdict: BLOCKED \(requires_ansible '>=2.17.0' excludes ansible-core 2.14.0\)$/);
  });

  it("says requires_ansible could not be evaluated instead of NOT satisfied, and does not block", () => {
    const text = renderUpgrade({
      collection: "x.y",
      installedVersion: "1.0.0",
      targetVersion: "2.0.0",
      dirLabel: "d",
      core: "2.21.5",
      requiresAnsible: "~=2.15",
      requiresOk: undefined,
      requiresError: 'invalid version "~=2.15" in constraint "~=2.15"',
      dependencies: [],
      cacheNote: "cached",
      constraints: [],
      used: [],
      playbookFiles: new Set(),
      findings: [],
      notFollowed: [],
      syntax: [],
      unused: [],
      warnings: [],
    });
    const lines = text.split("\n");
    expect(lines[1]).toBe(
      `target: requires_ansible '~=2.15' could not evaluate (invalid version "~=2.15" in constraint "~=2.15"; ansible-core 2.21.5); dependencies: none; cached`,
    );
    expect(text).not.toContain("NOT satisfied");
    expect(lines.at(-1)).toBe("verdict: NO IMPACT on used modules; requires_ansible not checked");
  });

  it("maps ansible-galaxy failures to plain answers (F18)", () => {
    expect(
      mapGalaxyError(readOut("galaxy/install-bad-version.stderr"), 1, "community.general", "99.0.0", "/p", []),
    ).toBe(
      "community.general 99.0.0 was not found on the configured Galaxy servers (the version or the collection does not exist, or the server needs credentials). Nothing in /p was changed.",
    );
    expect(mapGalaxyError(readOut("galaxy/install-offline.stderr"), 1, "ansible.posix", "1.6.2", "/p", ["2.0.0"])).toBe(
      "could not reach galaxy.ansible.com to download ansible.posix 1.6.2 (offline or proxy). Cached targets: 2.0.0. Nothing in /p was changed.",
    );
  });

  it("reports requirements constraints both ways", () => {
    const req = readOut("../project/requirements.yml");
    expect(constraintLines([{ file: "requirements.yml", text: req }], "ansible.posix", "1.5.4", "2.0.0")).toEqual([
      "requirements.yml:5 pins '2.0.0' (satisfied by the target; installed 1.5.4 violates it today)",
    ]);
  });
});

describe("ensureTarget: a stale tree at the cache target (U6)", () => {
  /** In-memory Ansible side: dir -> MANIFEST version (null = tree without MANIFEST.json). */
  function fakeCtx(failRename: (from: string, to: string) => boolean) {
    const trees = new Map<string, string | null>([["/c/collections/x.y/2.0.0", "1.0.0"]]);
    const removed: string[] = [];
    const runner = {
      prefixed: true,
      cfg: { timeoutMs: 1000 },
      sideJoin: (...parts: string[]) => parts.join("/"),
      sideCacheRoot: async () => "/c",
      sideEnv: async () => ({ HOME: "/home/u" }),
      sideMkdirp: async () => {},
      sideReadFile: async (path: string) => {
        const m = /^(.*)\/ansible_collections\/x\/y\/MANIFEST\.json$/.exec(path);
        if (!m) return null;
        const v = trees.get(m[1]!);
        return v ? JSON.stringify({ collection_info: { version: v } }) : null;
      },
      sideRename: async (from: string, to: string) => {
        if (trees.has(to) || !trees.has(from) || failRename(from, to)) return false;
        trees.set(to, trees.get(from)!);
        trees.delete(from);
        return true;
      },
      sideRemoveTemp: async (path: string) => {
        removed.push(path);
        trees.delete(path);
      },
      raw: async () => ({ code: 0, stdout: "", stderr: "" }),
    };
    const ctx = {
      runner,
      config: async () => ({ settings: [] }),
      runSafe: async (_p: unknown, _cmd: string, args: string[]) => {
        trees.set(args[args.indexOf("-p") + 1]!, "2.0.0");
        return { code: 0, stdout: "", stderr: "" };
      },
    } as any;
    return { ctx, trees, removed };
  }

  it("refuses with a clear error and leaves the stale tree in place when it cannot be moved aside", async () => {
    const { ctx, trees, removed } = fakeCtx((from) => from.endsWith("/2.0.0"));
    await expect(ensureTarget(ctx, { dir: "/p" } as any, "x.y", "2.0.0")).rejects.toThrow(
      "could not move the downloaded x.y 2.0.0 into the cache at /c/collections/x.y/2.0.0 (it holds a tree that says 1.0.0); remove that directory and retry.",
    );
    // No partial state: the old tree is untouched, the download is cleaned up,
    // and no .tmp-stale-* sibling was created.
    expect([...trees]).toEqual([["/c/collections/x.y/2.0.0", "1.0.0"]]);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/^\/c\/collections\/x\.y\/\.tmp-2\.0\.0-[0-9a-f]{8}$/);
  });

  it("removes both temp dirs when the stale tree moved aside but the download cannot take its place", async () => {
    const { ctx, trees, removed } = fakeCtx((from) => /\.tmp-2\.0\.0-/.test(from));
    await expect(ensureTarget(ctx, { dir: "/p" } as any, "x.y", "2.0.0")).rejects.toThrow(/could not move/);
    expect([...trees]).toEqual([]);
    expect(removed.map((r) => r.replace(/[0-9a-f]{8}$/, "*"))).toEqual([
      "/c/collections/x.y/.tmp-2.0.0-*",
      "/c/collections/x.y/.tmp-stale-*",
    ]);
  });

  it("replaces the stale tree when both moves succeed", async () => {
    const { ctx, trees, removed } = fakeCtx(() => false);
    const t = await ensureTarget(ctx, { dir: "/p" } as any, "x.y", "2.0.0");
    expect(t).toMatchObject({ dir: "/c/collections/x.y/2.0.0", downloaded: true });
    expect([...trees]).toEqual([["/c/collections/x.y/2.0.0", "2.0.0"]]);
    expect(removed).toHaveLength(2);
  });
});

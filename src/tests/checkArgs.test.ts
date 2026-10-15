import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkTask, docNamesFor, renderChecks, typeError } from "../checkArgs.js";
import { extractTask, ProjectFiles, parseKv, splitArgs, TASK_KEYWORDS, tasksOf } from "../project.js";
import { parseYaml } from "../yaml.js";
import { docResult, PROJECT, readOutJson } from "./helpers.js";

function check(yamlText: string, file = "t.yml") {
  const doc = parseYaml(yamlText);
  const tasks = doc.root?.kind === "map" ? [extractTask(doc.root, file, doc)] : tasksOf(doc.root, file, doc);
  const docs = docResult(docNamesFor(tasks));
  return tasks.map((t) => checkTask(t, docs));
}

describe("ansible_check_task_args on bad_args.yml (design.md 7.4)", () => {
  const files = new ProjectFiles(PROJECT);
  const abs = join(PROJECT, "playbooks", "tasks", "bad_args.yml");
  const doc = files.read(abs)!;
  const tasks = tasksOf(doc.root, files.rel(abs), doc);
  const docs = docResult(docNamesFor(tasks));
  const out = renderChecks(
    files.rel(abs),
    "ansible-core 2.21.5",
    tasks.map((t) => checkTask(t, docs)),
  );

  it("finds exactly the five hand-derived problems in three tasks", () => {
    expect(out.split("\n").slice(0, 13)).toEqual([
      "playbooks/tasks/bad_args.yml: 7 tasks checked against installed docs (ansible-core 2.21.5): 5 problems in 3 tasks",
      "  :3 ansible.builtin.copy [has action plugin; ansible-lint skips its arguments]",
      "    unknown option owner_name (line 7)",
      "    unknown option state (line 9)",
      "    backup (line 8): expected bool, got a string that is not a boolean ('maybe')",
      "  :12 ansible.posix.mount",
      "    missing required option path (aliases: name)",
      "  :18 ansible.builtin.file (key=value form): ok (dest is an alias of path)",
      "  :21 ansible.builtin.copy: ok by docs [not checked: src and content are mutually exclusive in the module's argument_spec, which ansible-doc does not expose]",
      "  :27 community.general.git_config: ok",
      "  :32 ansible.builtin.apt: ok; 2 templated values not checked (state, update_cache)",
      "  :38 community.general.ufw (from short name ufw)",
      "    proto (line 41): 'tcpx' is not one of any|tcp|udp|ipv6|esp|ah|gre|igmp",
    ]);
    expect(out).toMatch(/^not checked: cross-option rules/m);
  });
});

describe("checks beyond the fixture file", () => {
  it("flags YAML 1.1 traps: unquoted mode, booleans in choices", () => {
    const [c] = check("ansible.builtin.file:\n  path: /x\n  mode: 0755\n  state: directory\n");
    expect(c!.problems).toEqual(['mode 0755 (line 3) is the octal integer 493 in YAML 1.1; quote it ("0755")']);
    const [d] = check('ansible.builtin.copy:\n  dest: /x\n  content: "y"\n  mode: "0644"\n  follow: maybe\n');
    expect(d!.problems).toEqual(["follow (line 5): expected bool, got a string that is not a boolean ('maybe')"]);
  });

  it("treats aliases as satisfying required options, and reports conflicting actions", () => {
    const [c] = check("ansible.posix.mount:\n  name: /data\n  state: mounted\n  src: /dev/x\n  fstype: ext4\n");
    expect(c!.problems).toEqual([]);
    expect(c!.okLine).toContain("name is an alias of path");
    const [d] = check("ansible.builtin.copy:\n  dest: /a\n  content: x\nansible.builtin.file:\n  path: /b\n");
    expect(d!.problems).toEqual(["conflicting action statements: ansible.builtin.copy, ansible.builtin.file"]);
  });

  it("handles action: / local_action: forms, block recursion and duplicate keys", () => {
    const cs = check(
      [
        "- block:",
        "    - action: ansible.builtin.file path=/x state=nope",
        "  rescue:",
        "    - local_action:",
        "        module: ansible.builtin.copy",
        "        dest: /y",
        "        bogus: 1",
        "- ansible.builtin.file:",
        "    path: /a",
        "    path: /b",
      ].join("\n"),
    );
    expect(cs.map((c) => c.problems)).toEqual([
      ["state (line 2): 'nope' is not one of absent|directory|file|hard|link|touch"],
      ["unknown option bogus (line 7)"],
      ["duplicate key path (line 10); Ansible keeps the last one"],
    ]);
  });

  it("never echoes values of secret-like options", () => {
    const [c] = check("community.general.slack:\n  token: 12345\n  msg: hi\n  validate_certs: nope_FIXTURE\n");
    expect(c!.problems.join("\n")).not.toContain("12345");
  });

  it("does not report a `!vault` value as a type error (its type is decrypted at run time)", () => {
    const [c] = check(
      "ansible.builtin.apt:\n  name: vim\n  update_cache: !vault |\n    $ANSIBLE_VAULT;1.1;AES256\n    3031\n",
    );
    expect(c!.problems).toEqual([]);
  });

  it("reports unknown modules and not-installed short names", () => {
    const [c] = check("community.general.does_not_exist:\n  a: 1\n");
    expect(c!.problems).toEqual(["module/action not found in the installed collections"]);
  });
});

describe("parse_kv and the keyword list", () => {
  it("splits key=value text like Ansible", () => {
    expect(parseKv("dest=/tmp/x state=directory mode=0755")).toEqual({
      dest: "/tmp/x",
      state: "directory",
      mode: "0755",
    });
    expect(parseKv('msg="a b=c" x=1')).toEqual({ msg: "a b=c", x: "1" });
    expect(parseKv("echo hi creates=/x")).toEqual({ creates: "/x", _raw_params: "echo hi" });
    expect(parseKv("a\\=b c=d")).toEqual({ c: "d", _raw_params: "a=b" });
    expect(splitArgs("x={{ a b }} y='1 2'")).toEqual(["x={{ a b }}", "y='1 2'"]);
  });

  it("matches ansible-core 2.21's Task keywords (doc/keywords.json)", () => {
    const kw = readOutJson<Record<string, { applies_to: string[] }>>("doc/keywords.json");
    const task = Object.entries(kw)
      .filter(([, v]) => v.applies_to.includes("Task") || v.applies_to.includes("Handler"))
      .map(([k]) => k);
    for (const k of task) expect(TASK_KEYWORDS.has(k), k).toBe(true);
  });

  it("converts types the way Ansible does", () => {
    expect(typeError("bool", "yes")).toBeNull();
    expect(typeError("bool", "maybe")).toBe("a string that is not a boolean");
    expect(typeError("int", "42")).toBeNull();
    expect(typeError("int", "4x")).toBe("a string that is not an integer");
    expect(typeError("list", "a,b")).toBeNull();
    expect(typeError("dict", "a=1")).toBeNull();
    expect(typeError("dict", "nope")).toBe("a string that is neither key=value pairs nor JSON");
    expect(typeError("path", 3)).toBeNull();
  });

  it("reads a fixture file unchanged from disk (sanity)", () => {
    expect(readFileSync(join(PROJECT, "playbooks", "tasks", "bad_args.yml"), "utf8")).toContain("owner_name");
  });
});

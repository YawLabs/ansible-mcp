import { describe, expect, it } from "vitest";
import { extractTask, parseKv, type WalkTask } from "../project.js";
import { parseYaml } from "../yaml.js";

/**
 * Task extraction details that follow Ansible's ModArgsParser: parse_kv's
 * check_raw for the free-form command modules (P3), and the precedence of the
 * action's own arguments over the `args:` keyword (P4).
 */

function task(yamlText: string): WalkTask {
  const doc = parseYaml(yamlText);
  if (doc.root?.kind !== "map") throw new Error("expected one task mapping");
  return extractTask(doc.root, "t.yml", doc);
}

const argMap = (t: WalkTask) => Object.fromEntries(t.args.map((a) => [a.name, a.value]));

describe("parse_kv check_raw for free-form command modules (P3)", () => {
  it("keeps k=v text in _raw_params, except the command options", () => {
    expect(parseKv("env FOO=bar make", true)).toEqual({ _raw_params: "env FOO=bar make" });
    expect(parseKv("FOO=1 make creates=/x chdir=/tmp BAR=2", true)).toEqual({
      creates: "/x",
      chdir: "/tmp",
      _raw_params: "FOO=1 make BAR=2",
    });
    for (const k of ["removes", "executable", "warn", "stdin", "stdin_add_newline", "strip_empty_ends"]) {
      expect(parseKv(`run ${k}=v`, true), k).toEqual({ [k]: "v", _raw_params: "run" });
    }
  });

  it("is off by default (other modules' k=v pairs are options)", () => {
    expect(parseKv("env FOO=bar make")).toEqual({ FOO: "bar", _raw_params: "env make" });
  });

  it("applies to command, shell, raw, script, win_command, win_shell and their builtin/legacy names", () => {
    for (const mod of [
      "command",
      "shell",
      "raw",
      "script",
      "win_command",
      "win_shell",
      "ansible.builtin.command",
      "ansible.builtin.shell",
      "ansible.legacy.command",
      "ansible.legacy.raw",
      "ansible.windows.win_command",
      "ansible.windows.win_shell",
    ]) {
      const t = task(`${mod}: env FOO=bar make chdir=/src\n`);
      expect(argMap(t), mod).toEqual({ chdir: "/src", _raw_params: "env FOO=bar make" });
    }
  });

  it("applies to the action: / local_action: forms", () => {
    expect(argMap(task("action: shell FOO=1 ./run.sh creates=/done\n"))).toEqual({
      creates: "/done",
      _raw_params: "FOO=1 ./run.sh",
    });
    expect(argMap(task("local_action: command env A=1 true\n"))).toEqual({ _raw_params: "env A=1 true" });
  });

  it("leaves other free-form modules and plain modules on ordinary parse_kv", () => {
    expect(argMap(task("set_fact: a=b c=d\n"))).toEqual({ a: "b", c: "d" });
    expect(argMap(task("debug: msg=hi\n"))).toEqual({ msg: "hi" });
    expect(argMap(task("copy: src=a dest=b\n"))).toEqual({ src: "a", dest: "b" });
    expect(argMap(task("community.general.foo: x=1 y\n"))).toEqual({ x: "1", _raw_params: "y" });
  });
});

describe("args: keyword precedence (P4)", () => {
  it("the action's k=v arguments win over args:, which only adds missing ones", () => {
    const t = task('copy: src=a dest=b\nargs:\n  src: c\n  mode: "0644"\n');
    expect(argMap(t)).toEqual({ src: "a", dest: "b", mode: "0644" });
  });

  it("the action's dict arguments win over args:", () => {
    const t = task("copy:\n  src: a\nargs:\n  src: c\n  dest: d\n");
    expect(argMap(t)).toEqual({ src: "a", dest: "d" });
  });

  it("the action: form's arguments win over args:", () => {
    const t = task("action: copy src=a\nargs:\n  src: c\n  dest: d\n");
    expect(argMap(t)).toEqual({ src: "a", dest: "d" });
  });

  it("args: alone supplies every argument, last duplicate winning", () => {
    const t = task("file:\nargs:\n  path: /a\n  path: /b\n");
    expect(argMap(t)).toEqual({ path: "/b" });
    expect(t.form).toBe("dict");
  });
});

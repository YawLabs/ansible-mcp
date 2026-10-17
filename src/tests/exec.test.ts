import { afterEach, describe, expect, it } from "vitest";
import { AnsibleContext } from "../context.js";
import {
  AnsibleRunner,
  buildPrefixedArgv,
  decodeWslError,
  detectStyle,
  looksUtf16,
  missingBinaryPath,
  NATIVE_WINDOWS_MESSAGE,
  parsePrefix,
  readExecConfig,
  safetyEnv,
} from "../exec.js";
import {
  assertLocalPath,
  mountRootFromWslpath,
  PlainAnswer,
  parseWslUnc,
  relativeTo,
  winToWsl,
  wslToWin,
} from "../paths.js";
import { RESERVED_TOOL_NAMES } from "../tools.js";
import { cleanupTempDirs, type Recorded, readOut, replaySpawner, tempDir } from "./helpers.js";

describe("command prefix (design.md 3.1, 3.2)", () => {
  it("parses JSON and whitespace forms and detects the WSL style", () => {
    expect(parsePrefix('["wsl.exe","-d","Ubuntu","--exec"]')).toEqual(["wsl.exe", "-d", "Ubuntu", "--exec"]);
    expect(parsePrefix("wsl.exe -d Ubuntu --exec")).toEqual(["wsl.exe", "-d", "Ubuntu", "--exec"]);
    expect(parsePrefix("")).toBeNull();
    expect(() => parsePrefix("[oops")).toThrow(/not valid JSON/);
    expect(detectStyle(["C:\\Windows\\System32\\WSL.EXE", "--exec"], undefined)).toBe("wsl");
    expect(detectStyle(["ssh", "host"], undefined)).toBe("generic");
    expect(detectStyle(null, "wsl")).toBe("native");
  });

  it("refuses a wsl prefix that routes through bash (F20)", () => {
    expect(() => readExecConfig({ ANSIBLE_MCP_COMMAND_PREFIX: '["wsl.exe","--"]' }, "win32")).toThrow(
      /must use wsl\.exe --exec/,
    );
    expect(() => readExecConfig({ ANSIBLE_MCP_COMMAND_PREFIX: '["wsl.exe","-d","Ubuntu"]' }, "win32")).toThrow(
      /--exec/,
    );
    expect(
      readExecConfig({ ANSIBLE_MCP_COMMAND_PREFIX: "wsl.exe -e", ANSIBLE_MCP_PASS_ENV: "A, B" }, "win32"),
    ).toMatchObject({
      style: "wsl",
      passEnv: ["A", "B"],
    });
  });

  it("splices --cd before --exec and passes env through `env`, never a shell", () => {
    expect(
      buildPrefixedArgv({
        prefix: ["wsl.exe", "-d", "Ubuntu", "--exec"],
        cwd: "/mnt/c/p q",
        env: { A: "1", B: "it's $HOME" },
        unset: ["X"],
        bin: "/v/bin/ansible-doc",
        args: ["--json", "a b"],
        style: "wsl",
      }),
    ).toEqual([
      "wsl.exe",
      "-d",
      "Ubuntu",
      "--cd",
      "/mnt/c/p q",
      "--exec",
      "env",
      "-u",
      "X",
      "A=1",
      "B=it's $HOME",
      "/v/bin/ansible-doc",
      "--json",
      "a b",
    ]);
    expect(
      buildPrefixedArgv({
        prefix: ["ssh", "h", "--"],
        cwd: "/p",
        env: {},
        unset: [],
        bin: "b",
        args: [],
        style: "generic",
      }),
    ).toEqual(["ssh", "h", "--", "env", "-C", "/p", "b"]);
  });

  it("decodes wsl.exe's UTF-16 errors and missing binaries (F23)", () => {
    const probe = readOut("wsl/wsl-exec-probe.txt");
    // The probe captured wsl.exe's stdout for an unknown distro: UTF-16LE text, exit 4294967295.
    expect(probe).toMatch(/bad distro 4294967295 "" \| "T\\u0000h\\u0000e/);
    expect(probe).toContain("WSL_E_DISTRO_NOT_FOUND");
    const buf = Buffer.from(
      "There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n",
      "utf16le",
    );
    expect(looksUtf16(buf)).toBe(true);
    expect(decodeWslError(buf, "Nope")).toBe("WSL distro 'Nope' not found (wsl.exe -l lists them).");
    expect(
      missingBinaryPath(
        "<3>WSL (2751 - Relay) ERROR: CreateProcessCommon:875: execvpe(/nonexistent/bin/ansible-doc) failed: No such file or directory\n",
      ),
    ).toBe("/nonexistent/bin/ansible-doc");
    expect(missingBinaryPath("env: '/v/bin/ansible-doc': No such file or directory\n")).toBe("/v/bin/ansible-doc");
  });

  it("runs through the prefix with forwarded env, BIN_DIR on PATH and translated cwd", async () => {
    const calls: Recorded[] = [];
    const spawner = replaySpawner(
      [
        { tool: "wsl", has: ["wslpath"], stdout: "/mnt/c/\n" },
        { tool: "wsl", has: ["env"], not: ["/v/bin/ansible-doc"], stdout: "HOME=/home/me\nPATH=/usr/bin:/bin\n" },
        { tool: "wsl", has: ["/v/bin/ansible-doc"], stdout: "{}" },
      ],
      calls,
    );
    const prev = process.env.ANSIBLE_MCP_X;
    process.env.ANSIBLE_MCP_X = "fwd";
    try {
      const r = new AnsibleRunner(
        {
          prefix: ["wsl", "-d", "Ubuntu", "--exec"],
          binDir: "/v/bin",
          style: "wsl",
          passEnv: ["ANSIBLE_MCP_X"],
          timeoutMs: 1000,
          platform: "win32",
        },
        spawner,
      );
      await r.run("ansible-doc", ["--json", "x"], { cwd: "C:\\Users\\me\\p", env: { K: "v" }, unset: ["U"] });
      const last = calls.at(-1)!.args;
      expect(last.slice(0, 6)).toEqual(["-d", "Ubuntu", "--cd", "/mnt/c/Users/me/p", "--exec", "env"]);
      expect(last).toContain("ANSIBLE_MCP_X=fwd");
      expect(last).toContain("PATH=/v/bin:/usr/bin:/bin");
      expect(last).toContain("K=v");
      expect(last.slice(last.indexOf("-u"), last.indexOf("-u") + 2)).toEqual(["-u", "U"]);
      expect(await r.sideCacheRoot()).toBe("/home/me/.cache/ansible-mcp");
    } finally {
      if (prev === undefined) delete process.env.ANSIBLE_MCP_X;
      else process.env.ANSIBLE_MCP_X = prev;
    }
  });

  it("answers in plain text on native Windows with no prefix", async () => {
    const r = new AnsibleRunner({
      prefix: null,
      binDir: null,
      style: "native",
      passEnv: [],
      timeoutMs: 1000,
      platform: "win32",
    });
    await expect(r.run("ansible", ["--version"])).rejects.toBeInstanceOf(PlainAnswer);
    await expect(r.run("ansible", ["--version"])).rejects.toThrow(NATIVE_WINDOWS_MESSAGE);
  });
});

const WSL_CFG = {
  prefix: ["wsl", "-d", "Ubuntu", "--exec"],
  binDir: "/v/bin",
  style: "wsl" as const,
  passEnv: [],
  timeoutMs: 1000,
  platform: "win32" as const,
};

describe("Ansible-side env, cache root and temp removal (F24, design.md 6.5)", () => {
  it("does not cache a failed or empty env listing, and asks again", async () => {
    let n = 0;
    const calls: Recorded[] = [];
    const spawner = replaySpawner(
      [
        {
          tool: "wsl",
          has: ["env"],
          when: () => ++n > 2,
          stdout: "HOME=/home/me\n",
        },
        { tool: "wsl", has: ["env"], when: () => n === 2, stdout: "" },
        { tool: "wsl", has: ["env"], code: 1, stderr: "boom" },
      ],
      calls,
    );
    const r = new AnsibleRunner(WSL_CFG, spawner);
    await expect(r.sideEnv()).rejects.toThrow(/env exit 1\): boom/);
    await expect(r.sideEnv()).rejects.toThrow(/environment/);
    expect(await r.sideCacheRoot()).toBe("/home/me/.cache/ansible-mcp");
    expect(await r.sideCacheRoot()).toBe("/home/me/.cache/ansible-mcp");
    expect(calls.filter((c) => c.args.includes("env")).length).toBe(3);
  });

  it("refuses to fall back to /tmp when the Ansible side has no HOME", async () => {
    const r = new AnsibleRunner(WSL_CFG, replaySpawner([{ tool: "wsl", has: ["env"], stdout: "PATH=/usr/bin\n" }]));
    await expect(r.sideCacheRoot()).rejects.toThrow(/HOME is not set.*ANSIBLE_MCP_REMOTE_CACHE/);
    const o = new AnsibleRunner(WSL_CFG, replaySpawner([]), "/unused", "/srv/cache");
    expect(await o.sideCacheRoot()).toBe("/srv/cache");
  });

  it("sideRemoveTemp refuses anything but a .tmp-* dir under the guard root", async () => {
    const calls: Recorded[] = [];
    const r = new AnsibleRunner(WSL_CFG, replaySpawner([{ tool: "wsl", has: ["rm"] }], calls));
    const root = "/home/me/.cache/ansible-mcp/collections";
    for (const bad of [
      "/home/me/.cache/other/.tmp-1",
      "/home/me/.cache/ansible-mcp/collections-x/.tmp-1",
      `${root}/ns.name/1.0.0`,
      `${root}/.tmp-1/inside`,
      `${root}/../x/.tmp-y`,
      `${root}/ns.name/../../../.tmp-y`,
      `${root}/./.tmp-y`,
      root,
    ]) {
      await expect(r.sideRemoveTemp(bad, root), bad).rejects.toThrow(/refusing to remove/);
    }
    await expect(r.sideRemoveTemp(`/a/../b/.tmp-1`, "/a/../b")).rejects.toThrow(/refusing/);
    expect(calls).toEqual([]);
    await r.sideRemoveTemp(`${root}/ns.name/.tmp-1.0.0-abcd`, root);
    await r.sideRemoveTemp(`${root}\\ns.name\\.tmp-stale-ef01\\`, `${root}/`);
    expect(calls.map((c) => c.args.slice(4))).toEqual([
      ["rm", "-r", "-f", "--", `${root}/ns.name/.tmp-1.0.0-abcd`],
      ["rm", "-r", "-f", "--", `${root}\\ns.name\\.tmp-stale-ef01\\`],
    ]);
  });

  it("sideRename through a prefix is mv -T -- and reports a lost race as false", async () => {
    const calls: Recorded[] = [];
    const r = new AnsibleRunner(
      WSL_CFG,
      replaySpawner(
        [
          { tool: "wsl", has: ["mv", "/c/.tmp-1"], code: 0 },
          { tool: "wsl", has: ["mv"], code: 1, stderr: "mv: cannot overwrite" },
        ],
        calls,
      ),
    );
    expect(await r.sideRename("/c/.tmp-1", "/c/1.0.0")).toBe(true);
    expect(await r.sideRename("/c/.tmp-2", "/c/1.0.0")).toBe(false);
    expect(calls[0]!.args.slice(4)).toEqual(["mv", "-T", "--", "/c/.tmp-1", "/c/1.0.0"]);
  });
});

describe("ansible-doc argv and doc cache (design.md 4.1)", () => {
  afterEach(cleanupTempDirs);

  function ctxWith(docRoutes: Parameters<typeof replaySpawner>[0], calls: Recorded[]) {
    const spawner = replaySpawner(
      [
        ...docRoutes,
        { tool: "ansible", has: ["--version"], stdout: readOut("version.txt") },
        { tool: "ansible-config", has: ["dump"], stdout: readOut("config/only-changed.json") },
        { tool: "ansible-galaxy", has: ["collection", "list"], stdout: "{}" },
      ],
      calls,
    );
    const dir = tempDir();
    const ctx = new AnsibleContext({
      defaultDir: dir,
      cacheDir: tempDir(),
      spawner,
      exec: { prefix: null, binDir: null, style: "native", passEnv: [], timeoutMs: 10_000, platform: "linux" },
      env: {},
    });
    return ctx;
  }

  it("never puts a name starting with '-' on argv, and ends options with --", async () => {
    const calls: Recorded[] = [];
    const ctx = ctxWith([{ tool: "ansible-doc", has: ["--json"], stdout: "{}" }], calls);
    const p = await ctx.project();
    const r = await ctx.docs(p, ["--playbook-dir", "-M", "ansible.builtin.copy"]);
    expect(r.missing.sort()).toEqual(["--playbook-dir", "-M", "ansible.builtin.copy"].sort());
    const doc = calls.filter((c) => c.tool === "ansible-doc");
    expect(doc.length).toBe(1);
    expect(doc[0]!.args).toEqual(["--json", "-t", "module", "--", "ansible.builtin.copy"]);
    // Only dash names: no spawn at all.
    await ctx.docs(p, ["-M"], { extraArgs: ["--playbook-dir", "/x"] });
    expect(calls.filter((c) => c.tool === "ansible-doc").length).toBe(1);
  });

  it("replays a deprecation with a cached missing name", async () => {
    const calls: Recorded[] = [];
    const ctx = ctxWith(
      [
        {
          tool: "ansible-doc",
          has: ["--json"],
          stdout: "{}",
          stderr:
            "[DEPRECATION WARNING]: old.mod has been deprecated. Use new.mod instead.\n[WARNING]: old.mod was not found\n",
        },
      ],
      calls,
    );
    const p = await ctx.project();
    const first = await ctx.docs(p, ["old.mod"]);
    const second = await ctx.docs(p, ["old.mod"]);
    expect(calls.filter((c) => c.tool === "ansible-doc").length).toBe(1);
    for (const r of [first, second]) {
      expect(r.missing).toEqual(["old.mod"]);
      expect(r.deprecations).toEqual([{ name: "old.mod", text: "Use new.mod instead." }]);
    }
  });
});

describe("paths (design.md 3.3)", () => {
  it("translates Windows <-> WSL with a non-default mount root", () => {
    expect(winToWsl("C:\\a\\b c", "/mnt/")).toBe("/mnt/c/a/b c");
    expect(winToWsl("D:/x/", "/win/")).toBe("/win/d/x");
    expect(winToWsl("relative\\x", "/mnt/")).toBeNull();
    expect(wslToWin("/win/d/x/y", "/win/")).toBe("D:\\x\\y");
    expect(wslToWin("/home/me", "/mnt/")).toBeNull();
    expect(mountRootFromWslpath("/mnt/c/\n")).toBe("/mnt/");
    expect(mountRootFromWslpath("/c/")).toBe("/");
  });

  it("refuses UNC paths except the prefix's own WSL distro", () => {
    expect(() => assertLocalPath("\\\\evil\\share")).toThrow(/UNC or device path/);
    expect(() => assertLocalPath("//evil/share")).toThrow(/UNC/);
    expect(() => assertLocalPath("\\\\wsl.localhost\\Ubuntu\\tmp", "Ubuntu")).not.toThrow();
    expect(() => assertLocalPath("\\\\wsl$\\Other\\tmp", "Ubuntu")).toThrow(/UNC/);
    expect(() => assertLocalPath("\\\\wsl.localhost\\Ubuntu\\tmp")).toThrow(/-d/);
    expect(parseWslUnc("\\\\wsl.localhost\\Ubuntu\\tmp\\x")).toEqual({ distro: "Ubuntu", rest: "tmp/x" });
    expect(relativeTo("/p/a/b.yml", "/p")).toBe("a/b.yml");
    expect(relativeTo("/q/a", "/p")).toBeNull();
  });

  it("builds the safety environment (design.md 4.2)", () => {
    const s = safetyEnv({
      vaultFile: "/c/vault-null-1",
      cacheRoot: "/c",
      allowDynamicInventory: false,
      join: (a, b) => `${a}/${b}`,
    });
    expect(s.env).toMatchObject({
      ANSIBLE_VAULT_PASSWORD_FILE: "/c/vault-null-1",
      ANSIBLE_VAULT_IDENTITY_LIST: "ansible-mcp@/c/vault-null-1",
      ANSIBLE_INVENTORY_ENABLED: "host_list,yaml,ini,toml",
      ANSIBLE_VARS_ENABLED: "host_group_vars",
      ANSIBLE_LOCAL_TEMP: "/c/local-tmp",
      ANSIBLE_GALAXY_CACHE_DIR: "/c/galaxy-api",
      ANSIBLE_ASK_VAULT_PASS: "False",
    });
    expect(s.unset).toEqual(["ANSIBLE_VAULT_ID_MATCH"]);
    expect(
      safetyEnv({ vaultFile: "v", cacheRoot: "/c", allowDynamicInventory: true, join: (a, b) => `${a}/${b}` }).env,
    ).not.toHaveProperty("ANSIBLE_INVENTORY_ENABLED");
  });
});

describe("tool names (design.md section 0)", () => {
  it("never reuses an ADT MCP or PyPI ansible-mcp tool name", async () => {
    const { createAnsibleMcpServer } = await import("../server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createAnsibleMcpServer({ spawner: replaySpawner([]) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([client.connect(a), server.connect(b)]);
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(RESERVED_TOOL_NAMES).not.toContain(t.name);
      expect(t.name.startsWith("ansible_")).toBe(true);
    }
    await client.close();
  });
});

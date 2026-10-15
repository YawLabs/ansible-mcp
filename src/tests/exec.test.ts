import { describe, expect, it } from "vitest";
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
import { type Recorded, readOut, replaySpawner } from "./helpers.js";

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

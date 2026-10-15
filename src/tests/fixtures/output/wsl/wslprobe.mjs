import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

const D = "Ubuntu";
function run(args, opts = {}) {
  const t = Date.now();
  const r = spawnSync("wsl.exe", args, { encoding: "buffer", ...opts });
  return {
    ms: Date.now() - t,
    code: r.status,
    out: r.stdout.toString("utf8"),
    err: r.stderr,
    errUtf8: r.stderr.toString("utf8"),
    errUtf16: r.stderr.toString("utf16le"),
  };
}
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
let r = run(["-d", D, "--exec", "printf", "[%s]\\n", ...tricky]);
console.log("exec printf", r.ms, "ms code", r.code, "\n" + r.out);
r = run(["-d", D, "--", "printf", "[%s]\\n", ...tricky]);
console.log("-- printf (shell)", r.code, "\n" + r.out, r.errUtf8.slice(0, 200));
// latency x5
const lat = [];
for (let i = 0; i < 5; i++) lat.push(run(["-d", D, "--exec", "true"]).ms);
console.log("latency true", lat);
// env passing
r = run([
  "-d",
  D,
  "--exec",
  "env",
  "-u",
  "HOME",
  "FOO=bar baz",
  "sh",
  "-c",
  'echo "FOO=$FOO HOME=${HOME-unset} PATH=$PATH" | cut -c1-200',
]);
console.log("env", r.out);
// WSLENV route
r = run(["-d", D, "--exec", "sh", "-c", 'echo "VIA_WSLENV=$VIA_WSLENV"'], {
  env: { ...process.env, VIA_WSLENV: "x y", WSLENV: "VIA_WSLENV/u" },
});
console.log("wslenv", r.out);
r = run(["-d", D, "--exec", "sh", "-c", 'echo "NOT_PASSED=${NOT_PASSED-unset}"'], {
  env: { ...process.env, NOT_PASSED: "1" },
});
console.log("no wslenv", r.out);
// wslpath
const win = "C:\\Users\\jeff\\yaw\\mcp_servers\\ansible-mcp\\src\\tests\\fixtures\\project";
r = run(["-d", D, "--exec", "wslpath", "-a", "-u", win]);
console.log("wslpath -u", r.code, r.out, r.errUtf8);
r = run(["-d", D, "--exec", "wslpath", "-w", "/mnt/c/Users/jeff"]);
console.log("wslpath -w", r.out);
r = run(["-d", D, "--exec", "wslpath", "-w", "/tmp/ansible-mcp-work"]);
console.log("wslpath -w tmp", r.out);
r = run(["-d", D, "--exec", "wslpath", "-a", "-u", "C:\\path with space\\x"]);
console.log("wslpath nonexist", r.code, r.out, r.errUtf8);
// --cd
r = run(["-d", D, "--cd", win, "--exec", "pwd"]);
console.log("--cd win", r.code, r.out, r.errUtf16.slice(0, 200));
r = run(["-d", D, "--cd", "/tmp", "--exec", "pwd"]);
console.log("--cd linux", r.code, r.out);
// world-writable cfg check
const A = "/tmp/ansible-mcp-venv/bin/";
r = run([
  "-d",
  D,
  "--cd",
  win,
  "--exec",
  "env",
  "ANSIBLE_NOCOLOR=1",
  "ANSIBLE_COLLECTIONS_PATH=/tmp/ansible-mcp-work/collections",
  A + "ansible-config",
  "dump",
  "--only-changed",
  "--format",
  "json",
]);
console.log("drvfs config", r.code, r.out.slice(0, 600), r.errUtf8.slice(0, 600));
r = run([
  "-d",
  D,
  "--cd",
  win,
  "--exec",
  "env",
  "ANSIBLE_NOCOLOR=1",
  "ANSIBLE_CONFIG=/mnt/c/Users/jeff/yaw/mcp_servers/ansible-mcp/src/tests/fixtures/project/ansible.cfg",
  A + "ansible-config",
  "dump",
  "--only-changed",
  "--format",
  "json",
]);
console.log("drvfs config ANSIBLE_CONFIG", r.code, r.out.slice(0, 900), r.errUtf8.slice(0, 600));
r = run([
  "-d",
  D,
  "--exec",
  "stat",
  "-c",
  "%A %n",
  "/mnt/c/Users/jeff/yaw/mcp_servers/ansible-mcp/src/tests/fixtures/project",
  "/mnt/c/Users/jeff/yaw/mcp_servers/ansible-mcp/src/tests/fixtures/project/ansible.cfg",
]);
console.log("perms", r.out);
r = run(["-d", D, "--exec", "sh", "-c", "mount | grep ' /mnt/c '; cat /etc/wsl.conf 2>/dev/null"]);
console.log("mount", r.out);
// bad distro -> utf16 error
r = run(["-d", "NoSuchDistro", "--exec", "true"]);
console.log(
  "bad distro",
  r.code,
  JSON.stringify(r.errUtf8.slice(0, 80)),
  "|",
  JSON.stringify(r.out.slice(0, 80)),
  "| utf16:",
  JSON.stringify(Buffer.from(r.out, "utf8").toString("utf16le").slice(0, 200)),
  JSON.stringify(r.errUtf16.slice(0, 200)),
);
r = run(["-d", D, "--exec", "/nonexistent/bin/ansible-doc"]);
console.log("missing binary", r.code, JSON.stringify(r.errUtf8.slice(0, 200)), JSON.stringify(r.out.slice(0, 200)));
r = run(["-d", D, "--exec", "sh", "-c", "exit 7"]);
console.log("exit code", r.code);
// UNC read of WSL fs
try {
  console.log("unc readdir", fs.readdirSync("\\\\wsl.localhost\\Ubuntu\\tmp\\ansible-mcp-work").slice(0, 10));
} catch (e) {
  console.log("unc err", e.code, e.message);
}
try {
  console.log("unc$ stat", fs.statSync("\\\\wsl$\\Ubuntu\\tmp\\ansible-mcp-work\\project\\ansible.cfg").size);
} catch (e) {
  console.log("unc$ err", e.code);
}
// kill propagation
const child = spawn("wsl.exe", ["-d", D, "--exec", "sleep", "47"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
child.kill();
await new Promise((r) => setTimeout(r, 1500));
r = run(["-d", D, "--exec", "sh", "-c", "pgrep -a sleep | grep ' 47' || echo 'no sleep 47 left'"]);
console.log("after kill:", r.out);

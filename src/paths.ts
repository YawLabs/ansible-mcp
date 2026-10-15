/**
 * Path rules and Windows <-> WSL translation (design.md section 3.3). Pure.
 *
 * The server runs wherever Node runs; Ansible runs either natively or behind a
 * command prefix (`wsl.exe -d Ubuntu --exec`). Every `dir` is resolved on the
 * server's side, and only translated for the Ansible side when a command is
 * spawned. Translation is string work with a mount root learned once from
 * `wslpath`, never a shell.
 */

/** Thrown for facts that are an answer, not a failure (printed as plain text, not isError). */
export class PlainAnswer extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlainAnswer";
  }
}

/** `\\wsl.localhost\<distro>\rest` or `\\wsl$\<distro>\rest`, else null. */
export function parseWslUnc(p: string): { distro: string; rest: string } | null {
  const m = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i.exec(p);
  if (!m) return null;
  return { distro: m[1]!, rest: (m[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "") };
}

/**
 * Reject UNC and device paths (`\\host\share`, `//host/share`, `\\?\...`,
 * `\\.\...`) before any fs call touches them: on Windows a stat of a UNC path
 * opens an SMB connection, which can hand the user's NTLM hash to that host.
 * The one exception is a WSL path of the distro the prefix runs (`allowDistro`),
 * which is local 9P, not SMB.
 */
export function assertLocalPath(p: string, allowDistro?: string | null): void {
  if (!/^[\\/]{2}/.test(p)) return;
  const unc = parseWslUnc(p);
  if (unc && allowDistro && unc.distro.toLowerCase() === allowDistro.toLowerCase()) return;
  if (unc && !allowDistro) {
    throw new Error(
      `${p} is a WSL path, accepted only when ANSIBLE_MCP_COMMAND_PREFIX names that distro with -d (e.g. ["wsl.exe","-d","${unc.distro}","--exec"]).`,
    );
  }
  throw new Error(`${p} is a UNC or device path; only local directories are accepted. Pass \`dir\` as a local path.`);
}

/** `C:\a\b c` -> `<root>c/a/b c` (root like `/mnt/`). Returns null for anything that is not a drive path. */
export function winToWsl(p: string, mountRoot: string): string | null {
  const m = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(p);
  if (!m) return null;
  const root = mountRoot.endsWith("/") ? mountRoot : `${mountRoot}/`;
  const rest = (m[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return `${root}${m[1]!.toLowerCase()}${rest ? `/${rest}` : ""}`;
}

/** `/mnt/c/a/b` -> `C:\a\b` when under the mount root, else null. */
export function wslToWin(p: string, mountRoot: string): string | null {
  const root = mountRoot.endsWith("/") ? mountRoot : `${mountRoot}/`;
  if (!p.startsWith(root)) return null;
  const m = /^([a-z])(?:\/(.*))?$/i.exec(p.slice(root.length));
  if (!m) return null;
  return `${m[1]!.toUpperCase()}:\\${(m[2] ?? "").replace(/\//g, "\\")}`;
}

/** `/mnt/c/` (from `wslpath -a -u C:\`) -> `/mnt/`. */
export function mountRootFromWslpath(out: string): string {
  const line = out.trim().split(/\r?\n/)[0] ?? "";
  const m = /^(.*\/)c\/?$/i.exec(line);
  return m ? m[1]! : "/mnt/";
}

/** Forward-slash relative path of `p` under `base` (both on the same side), or null when outside. */
export function relativeTo(p: string, base: string): string | null {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = norm(p);
  const b = norm(base);
  if (a === b) return ".";
  const cmp = (x: string) => (/^[A-Za-z]:/.test(x) ? x.toLowerCase() : x);
  if (cmp(a).startsWith(`${cmp(b)}/`)) return a.slice(b.length + 1);
  return null;
}

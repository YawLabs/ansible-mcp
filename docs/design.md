# Design: ansible-mcp v0.1

Status: implemented in v0.1 (2026-10-15), verified against real Ansible output. Where the code deliberately
differs from this text: the task keyword list is pinned in `src/project.ts` (checked against `doc/keywords.json` by a
unit test) instead of being fetched per core version; `ansible-config dump` also gets
`ANSIBLE_LOCAL_TEMP` pointing at the server's cache (resolving the config creates a dir under local_tmp, and 4.1
promises nothing is written to `~/.ansible`), and that injected `DEFAULT_LOCAL_TMP` row is hidden in
`ansible_config`; the `--version` probes run under the full safety env (4.2) like every other child; `ansible_playbook_structure` prints each task's tags as Ansible lists them.
Scope: a read-only MCP server that answers "what is true in THIS Ansible checkout on THIS control node". Eleven
tools, all prefixed `ansible_`. npm only (no SEA binary), `"private": true` until the first publish.
House template: terraform-cwd-mcp (structure, Biome, vitest, scripts/lint.mjs, check:compliance grade A, release.sh,
oam launcher + scripts/runtime.mjs + check-oam-floor.mjs, doc set).

## 0. Positioning

Red Hat ships two MCP servers, and neither answers questions about a local checkout. AAP MCP reports what is true in
the controller. ADT MCP (`@ansible/ansible-mcp-server`, 26.6.0) takes actions: scaffolding, `ansible_lint` with
`fix=true`, `ansible_navigator` runs, environment setup and EE builds. The VS Code language server computes exact
option specs from installed collections, but only a person in the editor sees them; an agent cannot call it. So
agents guess module options from training data, and those drift between collection versions. That is the same gap
terraform-cwd-mcp fills for providers.

| Question | Authority |
|---|---|
| Controller jobs, templates, controller inventories, RBAC | AAP MCP |
| Scaffold, lint --fix, run via navigator, set up a venv or EE | ADT MCP |
| Interactive editing for a person | VS Code language server |
| Generate new content from intent | Lightspeed |
| Execute modules against hosts | Rocannon (not us) |
| Installed specs, task-argument validity, role interfaces, inventory, play structure, effective config, dependency drift, collection upgrade impact | **ansible-mcp** (read-only; never connects to a managed host) |

The tool descriptions and `INSTRUCTIONS` state this split in one line each, so an agent that has several servers
routes correctly.

**Name rule.** ADT MCP already ships `ansible_lint`, `ansible_navigator` and `ansible_create_*`, and the PyPI
`ansible-mcp` copies those names. The `ansible_` prefix does not prevent collisions behind an aggregator, so we never
reuse those exact names. That is why the lint tool is `ansible_lint_summary`. Before every release, a unit test checks
our tool names against the ADT list (`zen_of_ansible`, `ansible_content_best_practices`, `list_available_tools`,
`ansible_lint`, `ade_environment_info`, `ade_setup_environment`, `adt_check_env`, `create_ansible_projects`,
`ansible_create_playbook`, `ansible_create_collection`, `define_and_build_execution_env`, `ansible_navigator`) and
against the PyPI names (`lint`, `playbook_syntax_check`, `playbook_run`, `inventory_parse`, `inventory_graph`).

**Overlap risk.** The Red Hat Developers article of 2026-08-19 announces ansible-doc-grounded documentation for ADT
MCP. Neither 26.6.0 nor `main` (as of 2026-09-30) contains it. If it ships, `ansible_module_doc` overlaps with it.
The other ten tools are still unique to us.

## 1. Evidence: what was run

Environment: ansible-core 2.21.5, ansible-lint 26.10.1, Python 3.12.14, installed in a throwaway uv venv at
`/tmp/ansible-mcp-venv` inside WSL2 Ubuntu on a Windows 11 host. Collections were installed into scratch paths only,
via `ANSIBLE_COLLECTIONS_PATH`:

* installed set: ansible.posix 1.5.4 and community.general 9.5.2
* upgrade targets: ansible.posix 2.0.0 and community.general 11.4.0 / 12.0.0

Everything that was run:

1. The fixture project (`src/tests/fixtures/project/`). Every command each tool will issue was run against it:
   * `ansible --version`
   * `ansible-config dump`
   * `ansible-doc --json`, `-l -j`, `-t role` and `-t keyword`
   * `ansible-inventory --list`, `--host`, `--graph` and `--yaml`
   * `ansible-playbook --syntax-check`, `--list-tasks`, `--list-hosts` and `--list-tags`
   * `ansible-galaxy collection list` and `role list`
   * `ansible-lint` with json, codeclimate and sarif output
2. A never-execute probe project (`fixtures/hostile/`). Every hook in it touches a marker file. Each command was run
   with and without the environment overrides from section 4.
3. Vault behaviour, tested with whole-file and inline vaults:
   * no secret
   * a wrong secret
   * `/dev/null`
   * empty env overrides
   * the real password
4. Upgrade pairs:
   * `ansible-doc --metadata-dump` of all four versions, diffed with a scratch differ
   * `ansible-doc --json` of the used modules from the installed and target trees, diffed by hand (section 6.6)
   * `--syntax-check` against the target
   * Galaxy install errors: bad version, bad name, offline via a dead proxy, already present
5. A Node script on the Windows host (`fixtures/output/wsl/wslprobe.mjs`) that spawns `wsl.exe` the way the server
   will. It checked:
   * argv preservation
   * latency
   * env passing
   * `wslpath`
   * `--cd`
   * DrvFs permissions
   * error encodings
   * kill propagation
   * UNC reads

The committed fixtures are listed in `src/tests/fixtures/README.md`, and every file appears in
`fixtures/output/MANIFEST.tsv` with its command and exit code.

## 2. Findings that shaped the design

All of these were observed, not assumed.

F1. **What ansible-doc returns.** The JSON key is the name exactly as you asked for it, not the FQCN:
`ansible-doc --json apt` gives the key `apt`. Use these fields instead:
   * `doc.plugin_name`: the resolved FQCN after redirects (`apt` -> `ansible.builtin.apt`, `ufw` ->
     `community.general.ufw`)
   * `doc.collection`
   * `doc.filename`: tells which collection path won

   Each entry has `doc`, `examples`, `metadata` (null) and `return`. Options can carry `type`, `required`, `default`,
   `choices`, `aliases`, `elements`, `suboptions`, `version_added`, `version_added_collection` and `no_log`. When
   `type` is missing the type is `str`. `doc.attributes.check_mode.support` gives check-mode support.
   `doc.has_action` is true for modules that have an action plugin (copy, template).

F2. **Three ways a lookup fails.**
   * Missing plugin, or a redirect to an uninstalled collection: exit 0, stdout `{}`, stderr
     `[WARNING]: <name> was not found`. For the redirect case, stderr also carries a `[DEPRECATION WARNING]` naming
     the move (`community.general.proxmox_kvm` against 12.0.0).
   * Tombstoned plugin: exit 1, empty stdout, stderr `[ERROR]: module <name> Missing documentation (or could not
     parse documentation): The '<name>' module has been removed. <warning_text> This feature was removed from
     collection '<c>' version <v>.`
   * A batch that contains one tombstoned name fails as a whole (`target-multi-with-tombstone.stderr`). The server
     parses the name from that error, records it, and re-runs the batch without it.

F3. **ansible-doc cannot express cross-option rules or argument-spec-only deprecations.**
   * `mutually_exclusive`, `required_if`, `required_together`, `required_one_of` and `required_by` exist only in the
     module's Python `argument_spec`. For copy, `src` + `content` shows up only as prose in `content`'s description.
   * The community.general 9.5.2 docs give `git_config`'s `list_all` as a plain bool. The deprecation that
     ansible-lint prints ("Param 'list_all' is deprecated ... removed from collection 'community.general' version
     11.0.0") comes from the argument_spec's `removed_in_version`.
   * So `ansible_check_task_args` says exactly which checks it cannot do. It never claims "valid".

F4. **ansible-lint's `args[module]` skips modules that have action plugins.** On `bad_args.yml` it reported `mount`'s
missing `path` and `ufw`'s `proto: tcpx`. It said nothing about copy's unknown `owner_name`, unknown `state`, or
`backup: maybe`. A check based on docs catches those three. The lint rule imports module code (mocked
`AnsibleModule`), which also explains how it sees argument-spec deprecations. The two checks complement each other.

F5. **Ansible parses YAML 1.1 (PyYAML).** In the role arg spec, `choices: [off, self_signed, acme]` came back from
ansible-doc as `[false, "self_signed", "acme"]`. `yes`/`no`/`on`/`off` are booleans, and an unquoted `0755` is an
octal integer (493). The server's own YAML reader must use the same 1.1 schema, or it disagrees with Ansible. Where
the difference is likely a mistake, the server says so: "choice `off` parses as boolean false (YAML 1.1); quote it".

F6. **Vaults in ansible-inventory.**
   * Inline `!vault` values are never decrypted, even when a password is available. They appear as
     `{"__ansible_vault": "<ciphertext>"}`.
   * Whole-file vaulted vars files ARE decrypted when a password is available. `list-WITH-vault-password.json`
     contains `FIXTURE-SECRET-01` in clear text.
   * With no secret, `--list` and `--host` fail when any loaded vars file is whole-file vaulted: exit 4,
     `[ERROR]: Attempting to decrypt but no vault secrets found.`
   * With a wrong secret, the same files fail with exit 4, `Decryption failed (no vault secrets were found that could
     decrypt).`
   * `--graph` always works, because it loads no vars.
   * `--graph --vars` fails even when the only vaults are inline, because it renders values.

F7. **`vault_password_file` and `vault_identity_list` in ansible.cfg execute scripts.** This happens on every
`ansible-inventory`, `ansible-playbook` and `ansible-lint` run (marker `vault-password-script`).
   * Setting the variable to empty does not neutralize it: an empty value resolves to the cwd directory and the
     command fails ("can not be a directory").
   * `/dev/null` fails too: "Invalid vault password was provided from file (/dev/null)".
   * A server-owned file holding a random password works. Nothing executes, inline vault stays opaque, and whole-file
     vaults fail to decrypt (which F6 then handles).
   * `ansible-config dump` and `ansible-doc` do not run the script.

F8. **Script and plugin inventory sources execute on `--list` AND on `--graph`.** That covers `script`,
`constructed` (with a `pipe` lookup in `compose`) and, through `auto`, every cloud plugin.
`ANSIBLE_INVENTORY_ENABLED=host_list,yaml,ini,toml` prevents all of it. The `ini` plugin then emits "Failed to parse"
warnings for the skipped files, and the server summarizes those (section 4).

F9. **ansible-inventory does not template vars.** `db_password: "{{ vault_db_password }}"` comes out raw, and the
group_vars `pipe` lookup never ran. Two more details of the output:
   * Unsafe values (from `constructed`) appear as `{"__ansible_unsafe": "x"}`.
   * `_meta.profile` is `"inventory_legacy"`.

F10. **`ansible-playbook --syntax-check` and `--list-*` evaluate some project content on the control node.**
   * They template play-level `name`, `hosts` and `vars_files`, so a `pipe` lookup there runs.
   * They import playbook-adjacent `vars_plugins/*.py`, so module-level code runs. With
     `ANSIBLE_VARS_ENABLED=host_group_vars`, `get_vars` was not called.
   * They do NOT template task names, `include_tasks` file names, or group_vars values (all three were printed or
     left raw).
   * They do NOT import `filter_plugins/`.
   * Explicit `-i inventory/static.yml` changed nothing.
   * ansible-lint showed the same markers, because it runs syntax-check internally.

F11. **What `ansible-config dump --only-changed --format json` returns.** It runs no project code, even with the
hostile cfg. The result is a JSON array of `{name, origin, value}`. Origin is one of:
   * `env: VAR`
   * the cfg path
   * `""` for CONFIG_FILE

   The array ends with an object `{"GALAXY_SERVERS": {<server>: [{name, origin, type, value}, ...]}}`, and **galaxy
   server `token` and `password` values appear in clear text** (`config/galaxy-servers.json`). A setting overridden
   by env shows only the env origin; the cfg value is lost.

F12. **`ansible-galaxy collection list --format json` and `role list`.**
   * The collection list is `{"<path>/ansible_collections": {"<ns.name>": {"version": "x"}}}`, and `{}` when
     nothing matches.
   * Path keys come out in an order that is not the search order. With `ANSIBLE_COLLECTIONS_PATH=cg12:posix2:user`
     the user path was printed first. The effective version must be computed from COLLECTIONS_PATHS order (F25).
   * `role list` has no JSON. It printed each roles-path block twice (once from config, once from `-p`), and lists
     local roles as `(unknown version)`.

F13. **`--list-tasks` / `--list-hosts` / `--list-tags` text format** (no JSON exists).
   * Play header: `  play #N (<pattern>): <name>\tTAGS: [..]`
   * `    pattern: ['web']`, `    hosts (N):`, then one host per 6-space-indented line
   * Task lines: `      [<role> : ]<name>\tTAGS: [..]`, closed by `      TASK TAGS: [...]`
   * Role-dependency tasks come first, prefixed with their role.
   * Roles with argument specs get an inserted `Validating arguments against arg spec 'main' - <short_description>`
     task tagged `always`.
   * `include_tasks` is listed as a task and not expanded. `import_tasks` is expanded.
   * Templated task names are printed raw.
   * The three flags combine in one run (`playbook/list-all.txt`).

F14. **`--syntax-check` stops at the first error and does not validate module options.** It still makes a useful
upgrade confirmation. With the target collection first on the path it reported
`couldn't resolve module/action 'community.general.proxmox_kvm'` at `site.yml:22:7`, and it missed `git_config`'s
removed `list_all`. Each `[ERROR]` and `[DEPRECATION WARNING]` on stderr is followed by an `Origin: <file>:<line>:<col>`
line and a source excerpt (F16).

F15. **Writes outside the project.**
   * Every Ansible command creates `~/.ansible/tmp` (local_tmp).
   * `ansible-galaxy collection install` writes `~/.ansible/galaxy_cache/api.json`.
   * `ansible-lint --offline` wrote nothing into the project (before/after snapshot identical). Its caches go to
     `$XDG_CACHE_HOME`.
   * The server redirects local_tmp and the galaxy cache to its own cache (section 4).

F16. **Deprecation warnings carry a precise location.** They go to stderr as
`[DEPRECATION WARNING]: <text>` + `Origin: <file>:<line>:<col>` + an excerpt.
`ansible_playbook_structure` reports them, because they are free upgrade hints.

F17. **ansible-lint output.**
   * `-f json` and `-f codeclimate` produce the same bytes, a JSON array of `{type, check_name, categories, url,
     severity, description, fingerprint, location: {path, lines: {begin}} | {path, positions: {begin: {line,
     column}}}, content?}`.
   * `severity` is `major` for failures and `minor` for warnings (for example `args[module]`, which is
     experimental).
   * Exit codes: 0 means clean, 2 means violations.
   * SARIF is 2.1.0, with `level` error or warning.
   * Paths are relative to cwd when the targets are relative.
   * The stderr summary line looks like `Failed: 7 failure(s), 2 warning(s) in 19 files processed of 20
     encountered.`
   * A whole-project run lints inventory vars too, and logs vault decryption failures only as warnings.

F18. **Galaxy install behaviour.**
   * `ansible-galaxy collection install --no-deps -p <dir> <ns.name>:==<v>` installs into
     `<dir>/ansible_collections/...`. It warns that `<dir>` "is not part of the configured Ansible collections
     paths" (expected; filtered out).
   * Re-running it prints "Nothing to do. All requested collections are already installed."
   * A bad version and a bad name produce the same error text: "Failed to resolve the requested dependencies map.
     Could not satisfy the following requirements: * <spec> (direct request)". They cannot be told apart.
   * Offline: "Unknown error when attempting to call Galaxy at '<url>': <urlopen error [Errno 111] Connection
     refused>".
   * `collection download` writes a tarball plus a generated requirements.yml, and ansible-doc cannot read either
     until it is extracted. That makes `install -p` the right primitive.
   * Each failed install still left an empty `ansible_collections/` behind.

F19. **Timings** (inside WSL, warm):
   * `ansible-doc -l -j <collection>`: 0.4 s
   * `ansible-doc --json` of 10 modules in one call: 2.7 s
   * `--metadata-dump` of community.general: 4.7 s, 6.6 MB
   * Cold installs over the network: ansible.posix 2.0.0 took 9.6 s, community.general 11.4.0 17.7 s, and 12.0.0
     32 s.
   * Disk: about 28 MB per community.general version and 1.7 MB per ansible.posix version.

F20. **`wsl.exe -- cmd args` runs through a shell; `wsl.exe --exec cmd args` does not.**
   * With `--`, bash re-parsed the joined command line and `it's` broke it ("unexpected EOF").
   * `--exec` passed 14 tricky arguments byte-exact when spawned from Node with `shell: false`: spaces, `"`, `$HOME`,
     `;`, `*`, backslashes, a tab, an empty string, unicode, a trailing backslash, `%PATH%`, `'`, backticks, and
     `C:\Users\jeff`.

F21. **Windows env does not cross into WSL.** Without `WSLENV`, a variable set on the Windows side was unset inside.
`--exec env -u X K=V <cmd>` sets and unsets variables exactly. Under `--exec` no login shell runs, so neither
`~/.profile` nor an activated venv is loaded. The resulting PATH is the system PATH plus the appended Windows PATH.
ansible-lint warns "PATH altered to include /tmp/ansible-mcp-venv/bin" when its own bin dir is not on PATH, and it
needs `ansible-playbook` from that dir.

F22. **On DrvFs (`/mnt/c/...`) every file and directory shows as 0777.** As a result:
   * Ansible ignores `ansible.cfg` in the cwd: `[WARNING]: Ansible is being run in a world writable directory
     (...), ignoring it as an ansible.cfg source.`, and CONFIG_FILE is null.
   * Setting `ANSIBLE_CONFIG` to the same file explicitly makes Ansible load it.
   * Every inventory file also looks executable, which makes F8's `script` plugin dangerous on Windows checkouts in
     particular.

F23. **How wsl.exe reports errors.**
   * An unknown distro: exit 4294967295 (-1) and **UTF-16LE text on stdout** ("There is no distribution with the
     supplied name. Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND").
   * A missing binary: exit 1 and UTF-8 on stderr: `<3>WSL (1997 - Relay) ERROR: CreateProcessCommon:875:
     execvpe(<path>) failed: No such file or directory`.
   * Exit codes propagate (7 -> 7).
   * Killing `wsl.exe` killed the Linux process too (`sleep 47` was gone).
   * `--cd` accepts a Windows or a Linux path.
   * `wslpath -a -u` translates paths that do not exist.
   * Node can read `\\wsl.localhost\Ubuntu\...` and `\\wsl$\Ubuntu\...` (local 9P, not SMB).
   * Latency is 215-725 ms per wsl.exe call.

F24. **The WSL distro stops a few seconds after its last process exits, and `/tmp` is emptied on the next start.**
A venv created in `/tmp` was gone on the next call. Caches on the WSL side therefore default under the Linux
`$HOME`, never `/tmp`.

F25. **Putting a target tree first on the path works.** With `ANSIBLE_COLLECTIONS_PATH=<target>:<user paths>`,
ansible-doc resolves the target: every `doc.filename` in `upgrade/docs-target.json` points into the target tree.
Dependencies of the target that the user has installed still resolve from the user's paths.

## 3. Execution model: native and command-prefix (Windows via WSL)

Ansible does not support Windows as a control node. The server itself runs anywhere Node runs, and it reaches Ansible
in one of two ways.

### 3.1 Configuration

| Var | Default | Meaning |
|---|---|---|
| `ANSIBLE_MCP_COMMAND_PREFIX` | unset (native) | **JSON array** of argv prepended to every Ansible command, e.g. `["wsl.exe","-d","Ubuntu","--exec"]`. JSON because a prefix with spaces or quotes has no portable string form. A value that does not start with `[` is split on whitespace (no quoting), for the common `wsl.exe -d Ubuntu --exec`. |
| `ANSIBLE_MCP_BIN_DIR` | unset (use PATH) | Ansible-side directory that holds `ansible-*`, e.g. `/home/me/.venvs/ansible/bin`. Joined with `/` in prefix mode. Also prepended to the child's PATH (F21: ansible-lint needs `ansible-playbook` next to it). |
| `ANSIBLE_MCP_PATH_STYLE` | `auto` | `native` or `wsl`. `auto` = `wsl` when the prefix's first element's basename is `wsl` or `wsl.exe` (case-insensitive), else `native`. |
| `ANSIBLE_MCP_PASS_ENV` | unset | Comma-separated names of server env vars to forward to the Ansible side in prefix mode (F21: nothing crosses by default), e.g. `ANSIBLE_COLLECTIONS_PATH,HTTPS_PROXY`. In native mode the child inherits the env anyway. |

On win32 with no prefix, every tool answers with plain text, not an error:
`Ansible cannot run natively on Windows. Set ANSIBLE_MCP_COMMAND_PREFIX, e.g. ["wsl.exe","-d","Ubuntu","--exec"], and
ANSIBLE_MCP_BIN_DIR to the venv bin dir inside WSL.` Tools that need no subprocess (`ansible_role_interface` in
local-file mode, the static half of `ansible_project_info`) still work.

### 3.2 Spawning

All of it goes through a single `runAnsible(tool, args, { cwd, env, unset, timeoutMs })` that returns
`{ code, stdout: Buffer, stderr }`.

- **Native.** `spawn(binPath(tool), args, { cwd, env: merged, shell: false })`. Windows `.cmd`/`.bat` is refused
  (same rule and message shape as terraform-cwd-mcp), which is moot here because native win32 is refused anyway.
- **Prefix, style wsl.** The argv is:

  ```
  [...prefix, ...(cwd ? ["--cd", wslPath(cwd)] : []), "env", ...unset.flatMap(n => ["-u", n]), ...Object.entries(env).map(([k,v]) => `${k}=${v}`), binPath(tool), ...args]
  ```

  The prefix's `--exec` is required, and the server checks for it. A prefix ending in `--` or lacking `--exec` /
  `-e` is refused, because it routes through bash (F20): `ANSIBLE_MCP_COMMAND_PREFIX must use wsl.exe --exec
  (or -e), not --: with -- WSL re-parses the arguments with a shell.` (`--cd` must come before `--exec`, so when
  the prefix contains `--exec` the server splices `--cd <dir>` in just before it.)
- **Prefix, style native** (for example `["ssh","buildhost"]` or `["docker","exec","ctr"]`). These tools take
  different flags for cwd and env, so v0.1 supports only `wsl` style plus a generic form, `[..., "--"]`, that
  receives `env -C <cwd> K=V ... <bin> args` (GNU env 8.28+ `-C`). Its quoting is the prefix tool's problem, and the
  README says so. The tests and documentation cover only the WSL path. Anything else is "best effort, file an
  issue".
- No shell anywhere. Args are always arrays. User-supplied values (paths, patterns, tags) only ever appear as
  separate argv elements after a fixed flag, never concatenated into one string. Values that begin with `-` are
  refused where Ansible would read them as options (`limit`, `tags`, `group`, `host`, module `name`), with
  `<param> must not start with '-'`.
- stdout is collected as a Buffer stream (galaxy lists and metadata dumps run to MBs). stderr is capped at 64 KiB.
- Timeout: `ANSIBLE_MCP_TIMEOUT_MS`, default 120 000 (the upgrade download uses 3x). On expiry the server kills the
  child. In WSL mode that is `wsl.exe`, and the Linux process dies with it (F23).
- **wsl.exe failure decoding.** If stdout contains NUL bytes at odd offsets and the exit code is 4294967295 or -1,
  decode stdout as UTF-16LE and map it:
  * `WSL_E_DISTRO_NOT_FOUND`: `WSL distro '<d>' not found (wsl.exe -l lists them).`
  * other errors: `wsl.exe failed: <first line>`
  * stderr `execvpe(<path>) failed: No such file or directory`: `<tool> not found at <path> inside WSL. Set
    ANSIBLE_MCP_BIN_DIR to the directory holding ansible-core's executables (e.g. a venv's bin).`
  * native ENOENT: the same message with "on PATH".

### 3.3 Paths

- `dir` (every tool; default `ANSIBLE_MCP_DIR`, else `process.cwd()`) is resolved server-side and must be a local
  path. UNC and device paths are refused before any fs call (NTLM leak, as in terraform-cwd-mcp `assertLocalPath`),
  with one exception: in wsl style, `\\wsl.localhost\<distro>\...` and `\\wsl$\<distro>\...` are accepted when
  `<distro>` matches the prefix's `-d`. They map to `/<rest>` on the Ansible side, and the server reads them
  through the UNC path, which is local 9P (F23). The server reads YAML files itself (requirements, arg specs,
  tasks), so it must be able to read `dir` from its own side.
- **Windows -> Linux.** On first use the server runs `wslpath -a -u C:\` through the prefix once per process and
  caches the mount root (default `/mnt/c/` -> root `/mnt/`; `/etc/wsl.conf [automount] root` changes it). After
  that, translation is pure: `C:\a\b c` -> `<root>c/a/b c`. Drive letters are lowercased and separators flipped, with
  no shell involved. Any other drive form (`\\?\`, relative after resolve) is refused.
- **Linux -> Windows** for display. Paths that Ansible prints under `<root><letter>/` are shown as `X:\...`. Other
  Linux paths (`/home/me/.ansible/collections`, `/tmp/...`) are shown as-is and labelled `(inside WSL)`. They are
  never turned into `\\wsl.localhost` strings: the agent passes them back to us, not to Windows tools.
- **DrvFs config rule (F22).** In wsl style, when `<dir>/ansible.cfg` exists, `ANSIBLE_CONFIG` is not set in the
  forwarded env, and the translated dir is under the mount root, the server sets `ANSIBLE_CONFIG=<dir>/ansible.cfg`
  explicitly. This reproduces Ansible's normal "cwd cfg wins" search order. Without it Ansible silently ignores the
  cfg because DrvFs reports 0777. `ansible_project_info` and `ansible_config` print that it happened. In native mode
  the server never overrides. When stderr shows the world-writable warning there, the tool passes it on with "set
  ANSIBLE_CONFIG or fix the directory permissions".

### 3.4 Ansible-side home and caches

In prefix mode the server learns the Ansible side's `HOME` once per process with `env` through the prefix: it runs
`env` and parses `HOME=`. No shell is involved, and `printenv` would be equivalent. Caches on the Ansible side
default to `$HOME/.cache/ansible-mcp/` (never `/tmp`, F24). Override with `ANSIBLE_MCP_REMOTE_CACHE`.

## 4. Never-execute guarantees and the safety environment

### 4.1 What the server promises

1. **No module ever runs, and no managed host is ever contacted.** The server runs only these commands:
   * `ansible --version`, `ansible-config dump`
   * `ansible-doc` (`--json`, `-l -j`, `-t role`, `-t keyword`, `--metadata-dump`)
   * `ansible-inventory --list` / `--host` / `--graph`
   * `ansible-playbook --syntax-check` / `--list-tasks` / `--list-hosts` / `--list-tags`
   * `ansible-galaxy collection list`, `ansible-galaxy role list`
   * `ansible-galaxy collection install --no-deps -p <server cache>` (only in `ansible_upgrade_impact`)
   * `ansible-lint --offline -f codeclimate`

   It also runs `wslpath` and `env` for prefix plumbing. The `--syntax-check`/`--list-*` paths exit before a
   strategy or connection plugin is created. Gathering facts is a module run, so it never happens either.
2. **No `--check` / `--diff` run, not even for localhost with `connection=local`.** That decision is final for
   v0.1. Check mode is not read-only:
   * tasks with `check_mode: false` run for real
   * modules without check support can still have side effects
   * lookups and vars plugins execute
   * `connection=local` mutates the user's own machine

   The safety story could not be honest. The static argument check, syntax-check and list-tasks cover the value an
   agent needs.
3. **No vault secret is ever supplied, and configured vault scripts never run** (F6, F7; mechanism in section 4.2).
4. **Dynamic inventory is off by default** (F8). `ANSIBLE_MCP_ALLOW_DYNAMIC_INVENTORY=1` turns it back on, because
   such sources execute code and call cloud APIs. With it on, `ansible_inventory` and `ansible_playbook_structure`
   get `openWorldHint` behaviour, and their descriptions say so.
5. **The server never writes into `dir`, the user's collections and roles paths, requirements files, or
   `~/.ansible`.** Writes go only to the server's caches and temp dirs (F15).
6. **The server never passes `--fix`, `--write`, `--force` or `--become`, and never prompts.** Every `ask_*` setting
   is forced off, and stdin is `/dev/null`.

### 4.2 The safety environment (every Ansible child except `ansible-config dump`)

| Var | Value | Why |
|---|---|---|
| `ANSIBLE_VAULT_PASSWORD_FILE` | server-owned file with 32 random bytes (hex), mode 0600, created once under the Ansible-side cache (`vault-null`, reused by later server processes) | Replaces a configured script or file. The empty and `/dev/null` alternatives both fail (F7). |
| `ANSIBLE_VAULT_IDENTITY_LIST` | `ansible-mcp@<same file>` | Replaces `vault_identity_list = x@script` (verified: no marker, exit 0). |
| `ANSIBLE_ASK_VAULT_PASS`, `ANSIBLE_ASK_PASS`, `ANSIBLE_BECOME_ASK_PASS` | `False` | A cfg must not turn on a prompt that blocks on stdin. |
| `ANSIBLE_INVENTORY_ENABLED` | `host_list,yaml,ini,toml` (unless `ANSIBLE_MCP_ALLOW_DYNAMIC_INVENTORY=1`) | F8. Leaves out `script`, `auto` (cloud plugin configs), `constructed` and every collection plugin. |
| `ANSIBLE_VARS_ENABLED` | `host_group_vars` | Drops collection vars plugins enabled in cfg (they can call out). Playbook-adjacent legacy vars plugins are still imported, which is residual risk R1. |
| `ANSIBLE_LOCAL_TEMP` | `<side cache>/local-tmp` | F15 |
| `ANSIBLE_GALAXY_CACHE_DIR` | `<side cache>/galaxy-api` | F15 |
| `ANSIBLE_NOCOLOR=1`, `ANSIBLE_FORCE_COLOR=0`, `NO_COLOR=1` | | Clean text to parse. |
| `ANSIBLE_DEPRECATION_WARNINGS` | left alone | The warnings are useful (F16). |
| unset: `ANSIBLE_VAULT_ID_MATCH`, `ANSIBLE_CONFIG` only in the DrvFs case (it gets set, section 3.3) | | |

The `--version` probes (`ansible`, `ansible-lint --offline`, and the per-binary probes of `ansible_project_info`)
get the safety env too, although none of them performs a vault operation: verified with ansible-core 2.21.5 /
ansible-lint 26.10.1 run in the hostile project with no safety env at all (no marker from any `--version`, while
`ansible-inventory --list` touches `vault-password-script` and `inventory-script`). They read the effective config
like everything else (an ansible.cfg in their cwd, or a forwarded `ANSIBLE_CONFIG`), so the contract stays "every
child but `ansible-config dump`", and the integration test forces the hostile ansible.cfg on every child via a
forwarded `ANSIBLE_CONFIG`, checks each probe's argv carries it and the vault override, and expects no marker.

`ansible-config dump` runs with only the color variables (verified to execute nothing, F11), so it reports the
user's real vault/inventory settings instead of our overrides. Every other tool, whenever the user's effective config
had a value we replaced, adds one footer line: `safety: vault_password_file from ansible.cfg ignored (ansible-mcp
never supplies vault secrets); script inventory sources skipped (set ANSIBLE_MCP_ALLOW_DYNAMIC_INVENTORY=1 to allow).`
It learns which values were replaced from a cached `ansible-config dump --only-changed` per (dir, cfg mtime).

### 4.3 Residual risk (documented, not hidden)

R1. **Ansible evaluates some project content while parsing playbooks** (F10): Jinja in play-level `name`, `hosts`
and `vars_files`, and imports of playbook-adjacent `vars_plugins/*.py` and of plugin paths named in ansible.cfg.
This is the same trust a user extends by running `ansible-playbook --syntax-check`. It is stated in the README and
in the descriptions of `ansible_playbook_structure` and `ansible_lint_summary` ("parses playbooks with Ansible: treat
dir as code you would run --syntax-check on"). It parallels terraform-cwd-mcp's note that `providers schema` runs
provider plugins.

Mitigation, applied before spawning `ansible-playbook` or `ansible-lint` on a playbook: the server walks the playbook
with its own YAML reader (aliases resolved, keys included, up to an expansion limit), following `import_playbook`
(bare, `ansible.builtin.` or `ansible.legacy.`) with literal paths. A playbook outside `dir` is scanned at its real
path. If any play-level `hosts`, `name`, `vars_files` entry or `import_playbook` value mentions `lookup`, `query` or
`pipe` as a word (not only as a call: Jinja can bind them first, `{% set f = lookup %}`), or the word `q` after the
first `{{` / `{%`, it refuses with plain text:

```
playbooks/site.yml:3 play 'Web' has a lookup in 'hosts'; Ansible would run it on this machine while parsing. Not run.
Set ANSIBLE_MCP_ALLOW_PLAY_LOOKUPS=1 to allow.
```

It also lists any playbook-adjacent `vars_plugins/`, `library/`, `*_plugins/` dirs and cfg `*_plugins` paths in the
output as `local plugins loaded by Ansible: vars_plugins/marker_vars.py`. A target the pre-scan cannot fully read
(unreadable, over 32 MiB, or past the alias limit) is refused too, as is a lint folder target, or the no-`paths`
project walk, that has more than 200 000 entries or a folder that cannot be listed. Lint folder targets and the
no-`paths` case are walked at any depth, skipping only ansible-lint's own excludes (`.cache`, `.git`, `.hg`, `.svn`,
`.tox`), so every playbook ansible-lint can see is scanned. The pre-scan cannot see a play keyword that references a
variable whose value is a lookup defined elsewhere. That residue is stated, not claimed away.

R2. **Collections are code too.** `ansible-doc` parses plugin docs without importing modules, but ansible-lint's
`args` rule imports module code (F4). That is local code from installed collections, the same trust as Ansible
itself.

R3. **Galaxy downloads** (`ansible_upgrade_impact` only) contact Galaxy, or the servers configured in the project's
or user's cfg, possibly an Automation Hub with a token. ansible-galaxy authenticates; the server never prints the
token (section 5). `ansible-galaxy collection install` creates `~/.ansible/galaxy_token` when it is missing; when
the user has no token file and set no GALAXY_TOKEN_PATH, the server points ANSIBLE_GALAXY_TOKEN_PATH at its cache.

R4. **Empty dirs under `~/.ansible` (found during implementation).** Every Ansible command creates an empty
`~/.ansible` (ANSIBLE_HOME) when it does not exist, and ansible-lint (ansible-compat) creates empty
`~/.ansible/roles` and `~/.ansible/collections` when they are missing. Redirecting ANSIBLE_HOME would move the
default collections and roles paths away from the user's, so these empty dirs are accepted. Nothing is ever written
into an existing `~/.ansible` by the other commands (the integration test checks the mtimes).

## 5. Redaction

Every value printed from inventory, role defaults, config, lint messages or task arguments passes through
`redact.ts`. It is ported from terraform-cwd-mcp's four layers, adapted to the markers Ansible actually emits.

**Layer 1: Ansible markers (authoritative).**
* `{"__ansible_vault": ...}` (inline vault, F6) and any string starting with `$ANSIBLE_VAULT;` (vault text in YAML
  output or a plain var) become `<vaulted>`.
* Whole-file vaults are never decrypted (section 4.2). Where they matter, the fallback in section 7.6 lists the file
  as `<vaulted file>`.
* An option with `no_log: true` gets `(no_log)` in place of its default and any value we would echo. That covers
  role arg specs (verified on `webapp_admin_password` in `doc/role-webapp.json`) and module docs that carry
  `no_log`.
* `{"__ansible_unsafe": v}` is unwrapped to `v` before the other layers run, and the "unsafe" tag itself is not a
  secret.

**Layer 2: value matching.** Every string redacted by layers 1, 3 or 4 that is at least 4 characters long joins a
per-call set. Any other printed string that equals one of them, or contains one at least 8 characters long, becomes
`(redacted: contains a secret value)`. This catches a plain secret copied into a second var.

**Layer 3: key names.** terraform-cwd-mcp's tokenizer, `SECRET_TOKENS`, `SECRET_PAIRS`, metadata-suffix rule and
`NOT_SECRET_TOKENS`, copied verbatim and then extended for Ansible:
* `become`, `ssh`, `winrm`, `httpapi` stay neutral, so the secret-ness comes from `password`/`pass`. That catches
  `ansible_become_password`, `ansible_become_pass`, `ansible_ssh_pass`, `ansible_password`,
  `ansible_winrm_password` and `ansible_httpapi_password`.
* A leading `vault_` token makes a key secret unless its last token is metadata. This follows Ansible's documented
  `vault_<name>` convention (`vault_db_password`). `addr` and `address` are added to the metadata list, so
  `vault_addr` and `vault_url` stay visible.
* `private_key_file` stays visible (`file` is metadata; it is a path).

It applies to strings, numbers and bools under a secret-like own or ancestor key, exactly as in terraform-cwd-mcp.

**Layer 4: value shapes.** terraform-cwd-mcp's patterns: PEM and OpenSSH private keys, JWTs, GitHub/GitLab/Slack/npm
tokens, `sk-`, Google `AIza`, base64-encoded PEM, URL userinfo masked in place
(`smtp://mailer:(redacted)@mail.example.com:587`), and inline `password=...`. On top of those, `$ANSIBLE_VAULT;`.

Rules that hold everywhere:
- **ansible_config**: inside `GALAXY_SERVERS`, the entries `token`, `password` and `client_secret` print as
  `(redacted: galaxy credential)` whatever their value (F11). Settings with a secret-like name get layer 3, and every
  value gets layer 4 (proxy URLs with credentials).
- **ansible_inventory**: always redacted, with no "show secrets" parameter. A value that is exactly one Jinja
  expression with no quote characters inside (`"{{ vault_db_password }}"`) is printed as it is, labelled
  `(template, not rendered)`, even under a secret-like key: it is a reference, not a secret, and Ansible does not
  render it here (F9). A template with a quoted literal inside (`"{{ 'hunter2' | b64encode }}"`) gets layers 3 and 4
  like any other string. A footer counts the redactions: `redacted: 2 vaulted, 3 by name, 1 by value shape`.
- **ansible_check_task_args**: never prints task values, only option names. The one exception is the offending value
  in a choice or type error, and that is skipped (`got a value`) when the option is `no_log`, secret-like, or the
  value matches layer 4. A `!vault`-tagged value is skipped entirely (its type is only known after decryption).
- **ansible_upgrade_impact**: the same rule. The choice (`X no longer accepted`) and type-change (`value ... does not
  convert`) messages name the offending task value, so it prints as `a value` when the option is `no_log`,
  secret-like, or the value matches layer 4.
- **ansible_lint_summary**: messages pass through layer 4 (`args[module]` prints `got: <value>`).
- Accepted residual risk: hashes or fingerprints of secrets, and secrets inside free-form `command` strings in task
  files. Tasks are not echoed in the first place.

Fixture verification (a test requirement): every tool's output on `project/` and on the galaxy-config fixture
contains no `FIXTURE-SECRET` and no `FIXTURE-plain`.

## 6. ansible_upgrade_impact: download, cache and diff

Goal: for a collection the project uses and an exact target version, report what breaks in this project's tasks, tied
to file:line. Inputs are the installed arg specs vs the target's (ansible-doc), plus `meta/runtime.yml` routing
vs the target's, plus constraints from requirements.yml and `requires_ansible`. An optional syntax-check run against
the target confirms the result.

### 6.1 Inputs

- `collection` must match `^[a-z0-9_]+\.[a-z0-9_]+$`. Otherwise: `collection must be namespace.name, e.g.
  community.general`.
- `version` must be an exact version (`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`). A constraint gets
  `version must be an exact version like 12.0.0, not a constraint`.
- Installed version: `ansible-galaxy collection list <collection> --format json`, with the effective entry being the
  first path in `COLLECTIONS_PATHS` order (from the cached config dump), then ansible-core's own and sys.path
  locations (F12, F25). Not installed: plain text `community.general is not installed in any collections path
  (<paths>); nothing to compare. ansible_collections shows what requirements.yml expects.` Equal to the target:
  `already installed at 12.0.0`. Lower than installed: allowed, labelled `downgrade`.

### 6.2 Usage collection (static, server-side YAML 1.1 reader)

Walk the detected playbooks (section 7.1), every local role they reference (roles_path from config, then
`<playbook dir>/roles`, then `dir/roles`), role dependencies from `meta/main.yml`, and task files reached through
`import_tasks`/`include_tasks`/`import_role`/`include_role` with literal names. Templated names are listed as
`not followed: roles/webapp/tasks/main.yml:22 include_tasks "{{ ansible_os_family | lower }}.yml"`. For each task:
- **Action:** the single key that is not a task keyword. The keyword list comes from `ansible-doc -t keyword --json
  <all>`, filtered by `applies_to` Task/Handler (fixture `doc/keywords.json`, 60 keywords in 2.21.5), and cached per
  ansible-core version. Also `action:` / `local_action:` (string or dict form) and `with_<lookup>`.
- **Args:** a dict, or free-form `k=v` (Ansible `parse_kv` rules: shlex-style quotes, `\=` escapes, and for
  free-form modules the non-k=v remainder is `_raw_params`), merged with `args:`; the action's own args win over
  `args:`, as in Ansible's ModArgsParser. For `command`, `shell`, `raw`, `script`, `win_command` and `win_shell`
  (`check_raw`), only `creates`, `removes`, `chdir`, `executable`, `warn`, `stdin`, `stdin_add_newline` and
  `strip_empty_ends` become options; any other `k=v` (`env FOO=bar make`) stays in `_raw_params`. The dict form
  `action: {module: "command ..."}` is split the same way, and the module string's args win over the other keys.
  Each arg keeps its line number.
- **Resolution to FQCN:** names containing two dots are used as given. Short names (and every name, to follow
  redirects) are resolved in one batched `ansible-doc --json <names...>` call. `doc.plugin_name` gives the FQCN
  (verified: `ufw` -> `community.general.ufw`, `mount` -> `ansible.posix.mount`). A play or role `collections:`
  keyword is honoured by trying each listed prefix first.
- Plugin references in Jinja strings (`lookup('ns.c.x'`, `query(`, `| ns.c.filter`, `is ns.c.test`) are collected
  by regex when fully qualified. They get routing checks (tombstone, redirect, removal) but no option diff in v0.1.

Only usages that resolve into `collection` count.

### 6.3 Target tree (download + cache)

- Cache root (Ansible side): `ANSIBLE_MCP_REMOTE_CACHE` or, in native mode, `ANSIBLE_MCP_CACHE`. The default is
  `<home>/.cache/ansible-mcp`. Target dir: `<root>/collections/<ns>.<name>/<version>/`. A hit means
  `<target>/ansible_collections/<ns>/<name>/MANIFEST.json` exists and its `collection_info.version` equals
  `version`. On a hit no network is used, which makes offline reruns work.
- On a miss:
  1. Create `<root>/collections/<ns>.<name>/.tmp-<version>-<random>`.
  2. Run `ansible-galaxy collection install --no-deps -p <tmp> <ns>.<name>:==<version>` with cwd = `dir`, so the
     project's galaxy servers and credentials apply. The safety env is set, plus `ANSIBLE_GALAXY_CACHE_DIR`, and
     the timeout is 3x.
  3. Verify MANIFEST.json, then rename `<tmp>` to `<target>`: `fs.renameSync` in native mode, `mv -T <tmp> <target>`
     through the prefix in WSL mode.
  4. If the rename fails because another process won the race, use the winner's tree and remove ours.
  5. Temp dirs are removed in `finally`. Removal goes through `rm -rf -- <tmp>` in WSL mode, only after asserting
     that the path starts with `<root>/collections/` and contains `/.tmp-`.
  6. At startup, `.tmp-*` dirs older than 1 h are swept in the background (as in terraform-cwd-mcp).
- Why `install -p` and not `download`: F18.
- What is never done: no `-p` pointing into a configured collections path, no `-r requirements.yml`, no `--force`,
  no `--upgrade`, and the user's paths are never written to.
- Dependencies: `--no-deps` downloads only the target. Its `MANIFEST.json` `dependencies` are compared with the
  installed collections. Unsatisfied ones become a `WARNING: 12.0.0 depends on x.y >=1.0 (installed: none); docs
  that need it may fail`. Since target-first-then-user paths (F25) still resolve installed dependencies, ansible-doc
  usually works anyway.
- Measured cost: 9-32 s cold per version (F19), and about 28 MB on disk for community.general. The cache is never
  evicted automatically. The README documents where it lives and that deleting it is safe.
- Failure messages (from F18):

| Ansible text | Our message |
|---|---|
| `Could not satisfy the following requirements: * <spec>` | `<ns.name> <version> was not found on the configured Galaxy servers (the version or the collection does not exist, or the server needs credentials). Nothing in <dir> was changed.` |
| `Unknown error when attempting to call Galaxy at '<url>': <urlopen error ...>` | `could not reach <host> to download <ns.name> <version> (offline or proxy). Cached targets: <list or none>. Nothing in <dir> was changed.` |
| `Failed to download collection tar from '<server>': <urlopen error ...>` (API reached, tarball download broke; seen as a connection reset) | `could not reach Galaxy server '<server>' to download <ns.name> <version> (download failed: <reason>). Cached targets: <list or none>. Nothing in <dir> was changed.` |
| anything else, nonzero | `ansible-galaxy collection install failed (exit N):` + stderr (capped at 2 KiB, layer-4 redacted) |

### 6.4 Docs and routing for both sides

- Installed docs: `ansible-doc --json <used fqcns>` with the normal env, batched (at most 50 per call; F19 suggests
  about 0.25 s per module).
- Target docs: the same, with `ANSIBLE_COLLECTIONS_PATH=<target>:<COLLECTIONS_PATHS joined>` (F25). Which
  collection path won is checked through `doc.filename`. If a module's filename is not under `<target>`, the target
  lacks it and resolution fell through to the installed copy. The module is then treated as absent from the target,
  and routing explains why.
- Tombstone handling: F2. Parse `module (\S+) Missing documentation .* has been removed\. (.*) This feature was
  removed from collection '([^']+)' version ([^ .]+)`, record it, and re-run without that name.
- `meta/runtime.yml` for both sides is read by the server: from the doc `filename`'s collection root for installed,
  and from `<target>/ansible_collections/<ns>/<name>/meta/runtime.yml` for the target. In WSL mode it is read through
  the prefix (`cat -- <path>`), and in native mode with `fs`. The server reads `requires_ansible` and
  `plugin_routing.<type>.<name>.{redirect, deprecation{removal_version, removal_date, warning_text},
  tombstone{removal_version, removal_date, warning_text}}`. Short names are matched both bare and with the
  collection prefix.

### 6.5 Rules (per used module, then per used option)

| Rule | Severity | Real example in the fixture |
|---|---|---|
| target runtime has `tombstone` for the plugin | BREAKING | consul_acl (removed in 10.0.0) |
| target routes `redirect: X` and X does not resolve | BREAKING `moved to X; <collection of X> is not installed` | proxmox_kvm -> community.proxmox.proxmox_kvm |
| target routes `redirect: X` and X resolves | WARNING `moved to X (installed <v>); update the task to the new name` | (unit test) |
| plugin absent from target and no routing | BREAKING `removed` | (unit test; the 9 -> 12 module removals all have routing) |
| module deprecated in target (`doc.deprecated` or runtime `deprecation`) and not in installed | DEPRECATION `removed in <v>: <why>; use <alternative>` | (none used; e.g. atomic_* in 12.0.0) |
| option set by the task, absent from target options and aliases | BREAKING `option removed` | git_config.list_all |
| alias used by the task, dropped in target while the option survives | BREAKING `alias <a> dropped; use <option>` | (unit test) |
| option not set, `required: true` in target and not in installed | BREAKING `newly required, not set` | git_config.name |
| literal value no longer in `choices` | BREAKING `<value> no longer accepted (choices: ...)` | rhsm_repository.state=present |
| `type` changed: literal value convertible to the new type (Ansible's conversion rules, section 7.4) | INFO `type <a> -> <b>; this value still converts` | firewalld.masquerade "yes" str -> bool |
| `type` changed: value not convertible / templated | BREAKING / WARNING `cannot evaluate a templated value` | (unit test) |
| option not set, `default` changed | BEHAVIOR CHANGE `default <a> -> <b>` | slack.prepend_hash 'auto' -> 'never'; firewalld.offline None -> False |
| option deprecated in target docs | DEPRECATION | (unit test) |
| new options, added choices, removed plugins the project does not use | not listed (counted under `include_unused`) | ufw.proto gained vrrp; mount gained opts_no_log |
| target `requires_ansible` excludes installed ansible-core | BLOCKED | (unit test; cg 12 needs >=2.17.0, posix 2.0.0 >=2.15.0, both satisfied by 2.21.5) |
| target `requires_ansible` cannot be evaluated (e.g. `~=2.15`) | header says `could not evaluate`; verdict not BLOCKED, notes it was not checked | (unit test) |
| a requirements.yml entry's version constraint excludes the target | INFO `requirements.yml:<line> pins '<constraint>': change it to allow <version>` | community.general ">=9.0.0,<10.0.0" |

Option paths include suboptions (`dotted.path`, recursing into `suboptions` for dict and list-of-dict options). The
task value is then walked the same way. Defaults are compared with JSON equality after one normalization step: a
missing `default` is `null`. `"0"` vs `0` stays a difference, because Ansible treats them as different literals.

Verdict precedence: `BLOCKED` > `BREAKING (N)` > `BEHAVIOR CHANGES (N)` > `DEPRECATIONS ONLY` > `NO IMPACT on
used modules`. The suffixes `; also BREAKING (N)` etc. are appended, as in terraform-cwd-mcp.

### 6.6 Hand-verified expected results (fixture `project/`)

The diff below was produced by a scratch differ over `upgrade/docs-installed.json` and `upgrade/docs-target.json`,
plus the runtime files. Each line was re-checked by reading the JSON:

* `git_config` 12.0.0 options are `add_mode file name repo scope state value`, with `name.required: true`
* rhsm_repository `state.choices` changed from `[present, enabled, absent, disabled]` to `[enabled, disabled]`
* slack `prepend_hash.default` changed from `auto` to `never`
* firewalld `masquerade` / `icmp_block_inversion` changed type from `str` to `bool`, and `offline` / `permanent`
  defaults changed from `null` to `false`
* the proxmox_kvm redirect and the consul_acl tombstone appear in `cg-12.0.0-runtime-excerpt.yml`

Expected output for community.general 9.5.2 -> 12.0.0 (format as specified; lines assembled from the verified diff):

```
upgrade community.general 9.5.2 -> 12.0.0 (major) for <dir>
target: requires_ansible '>=2.17.0' ok (ansible-core 2.21.5); dependencies: none; downloaded (cache: <path>)
constraints: requirements.yml:3 pins '>=9.0.0,<10.0.0' (change it to allow 12.0.0)
used modules (7): git_config, proxmox_kvm, consul_acl, slack, rhsm_repository (playbooks/site.yml); timezone (roles/common/tasks/main.yml); ufw (roles/webapp/tasks/main.yml, via short name ufw)
BREAKING (5):
  playbooks/site.yml:17 community.general.git_config: option list_all removed (line 19)
  playbooks/site.yml:17 community.general.git_config: name is newly required, not set
  playbooks/site.yml:23 community.general.proxmox_kvm: moved to community.proxmox.proxmox_kvm; community.proxmox is not installed (add it to requirements.yml)
  playbooks/site.yml:31 community.general.consul_acl: removed in 10.0.0 (tombstone): Use community.general.consul_token and/or community.general.consul_policy instead.
  playbooks/site.yml:43 community.general.rhsm_repository: state=present no longer accepted (choices: enabled, disabled) (line 45)
BEHAVIOR CHANGES (1):
  playbooks/site.yml:37 community.general.slack: prepend_hash not set; default 'auto' -> 'never'
syntax-check with 12.0.0 (playbooks/site.yml): first error playbooks/site.yml:22: couldn't resolve module/action 'community.general.proxmox_kvm' (syntax-check stops at the first error and does not check options)
verdict: BREAKING (5)
```

The task line is the line of the task's action key (the module name), and the option line is the option's
key. Every tool uses the action-key line as a task's location. The `syntax-check` line uses the line from Ansible's `Origin:`, which points at the task (`22`).
`ufw` and `timezone` have no findings, and `ufw.proto` gaining `vrrp` is additive. Baseline syntax-check with the
installed set passes (`playbook/syntax-check.stdout`, exit 0), so the error is attributed to the upgrade.

ansible.posix 1.5.4 -> 2.0.0:

```
upgrade ansible.posix 1.5.4 -> 2.0.0 (major) for <dir>
target: requires_ansible '>=2.15.0' ok (ansible-core 2.21.5); dependencies: none
constraints: requirements.yml:5 pins '2.0.0' (satisfied by the target; installed 1.5.4 violates it today)
used modules (3): firewalld (roles/webapp/tasks/main.yml), sysctl (playbooks/site.yml), mount (roles/common/tasks/main.yml, via short name mount)
BEHAVIOR CHANGES (1):
  roles/webapp/tasks/main.yml:13 ansible.posix.firewalld: offline not set; default null -> false
INFO (1):
  roles/webapp/tasks/main.yml:13 ansible.posix.firewalld: masquerade type str -> bool; value 'yes' still converts (line 17)
syntax-check with 2.0.0: ok
verdict: BEHAVIOR CHANGES (1)
```

(`permanent`'s default also changed from null to false, but the task sets `permanent: true`, so it is not listed.)

### 6.7 Concurrency, annotations

- Upgrade calls are serialized in-process. Temp-dir-and-rename makes concurrent server processes safe.
- Annotations: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, **`openWorldHint: true`**
  (Galaxy on a cache miss). The description says: "Downloads the target collection from Galaxy (or the configured
  servers) into this server's cache on first use; never touches dir, requirements files or your collections paths."

## 7. Tool specifications

Shared conventions (as in terraform-cwd-mcp):
* Output is plain text. The first line is a header, items are indented two spaces, and flags go in `[brackets]`.
* Renderers are pure functions in their own modules, and handlers are wrapped in `guard()`, so a thrown error becomes
  an `isError` result prefixed `Error: `.
* Facts are normal text, not errors: "not found", "not installed", "no requirements file", "refused by the lookup
  pre-scan".
* Every tool takes `dir`, a string with `maxLength: 4096`.
* String caps: paths 4096, plugin names 256, versions 64, patterns/tags/limits 512, queries 256, inline YAML 100 000.
  Every number has min/max. Every tool has a `title`, a description of at most 2 sentences plus the authority line,
  and annotations. `check:compliance` must stay at grade A.
* Every Ansible-backed tool header names the ansible-core version and, in prefix mode, `(via wsl.exe -d Ubuntu)`.

Default annotations, `READ_ONLY_LOCAL`: `readOnlyHint: true, destructiveHint: false, idempotentHint: true,
openWorldHint: false`.

### 7.1 ansible_project_info

```ts
{ dir }
```

Annotations: READ_ONLY_LOCAL.

**Commands.** These run in parallel: `ansible --version` (F1 format: the first line `ansible [core X]`, then `  key =
value` lines), `ansible-config dump --only-changed --format json`, and `<tool> --version` for ansible-doc,
-inventory, -playbook, -galaxy, -config and -lint (exit 0 means present).

**Static detection** in `dir`, at most 3 levels deep, skipping `.git`, `node_modules`, `.venv` and `collections/`
contents:
* playbooks: a YAML file whose root is a list of mappings that each have `hosts`, `import_playbook` or
  `ansible.builtin.import_playbook`
* inventories: the cfg `inventory`, `inventory/`, `hosts*`, `*.ini`, or a YAML file with `all:` / `children:` roots;
  each one's kind (static yaml/ini, or script/plugin config) is labelled
* roles: dirs with `tasks/main.yml` or `meta/main.yml`
* requirements files
* `ansible.cfg`, `.ansible-lint`, `execution-environment.yml`, `ansible-navigator.yml`
* a project-local `collections/ansible_collections`

Example output (lines from the fixture captures):

```
ansible project <dir> (ansible-core 2.21.5 via wsl.exe -d Ubuntu --exec, python 3.12.14, jinja 3.1.6)
config file: <dir>/ansible.cfg [set via ANSIBLE_CONFIG: DrvFs reports Windows folders as world-writable]
collections paths: /home/me/.ansible/collections, /usr/share/ansible/collections (inside WSL)
roles path: <dir>/roles
binaries: ansible-doc ansible-inventory ansible-playbook ansible-galaxy ansible-config ansible-lint 26.10.1
playbooks (1): playbooks/site.yml (3 plays)
inventories (1): inventory/hosts.yml (yaml, from ansible.cfg) + group_vars/host_vars (1 whole-file vault)
roles (2): common, webapp [argument_specs]
requirements: requirements.yml (3 collections, 1 role)
```

### 7.2 ansible_module_doc

```ts
{
  name: z.string().max(256),        // FQCN or short name; must not start with '-'
  type: z.string().max(32).optional().default("module"),  // module|lookup|filter|test|callback|connection|inventory|become|cache|vars|strategy|shell|cliconf|httpapi|netconf|keyword|role; validated in the handler with a plain-text answer
  dir,
  include_return: z.boolean().optional().default(true),
  include_examples: z.boolean().optional().default(false),
  description_chars: z.number().int().min(0).max(2000).optional().default(160),
}
```

Annotations: READ_ONLY_LOCAL. Command: `ansible-doc --json -t <type> -- <name>` (a name starting with `-` is never
passed). The result is cached in memory (7.12).
The collection version comes from `ansible-galaxy collection list --format json`, matching `doc.filename` to a path
prefix. ansible.builtin gets `ansible-core <v>`.

Output:

```
community.general.ufw (module, community.general 9.5.2) [resolved from 'ufw'] - Manage firewall with UFW
check_mode: full | requirements: ufw package
options (19):
  comment (str) - Add a comment to the rule.
  default (str) [choices: allow|deny|reject] [aliases: policy] - Change the default policy for incoming or outgoing traffic.
  proto (str) [choices: any|tcp|udp|ipv6|esp|ah|gre|igmp] [aliases: protocol] - TCP/IP protocol.
  to_port (str) [aliases: port] - Destination port.
  ...
not in ansible-doc output: cross-option rules (mutually_exclusive, required_if, ...); see the module description and notes
returns: (none documented)
```

Flags: `[required]`, `[default: x]` (JSON, redacted by secret-like name and value shape, so a harmless default
such as `private_key_file` can show as redacted), `[elements: t]`, `[deprecated: removed in v, use y]`, `[no_log]`,
`[added in <collection> <v>]` (only when newer than the installed major's x.0.0). Suboptions are indented under
their parent. `[has action plugin]` is shown when `doc.has_action`. Module deprecation goes in the header.

Not found (`{}` + "was not found", F2): `<name> (<type>) is not installed (searched: <collections paths>). Try
ansible_module_search.` When stderr also carried a redirect deprecation (redirect to a missing collection):
`<name> moved to <target> (<warning text>); <collection> is not installed.` Tombstone:
`<name> was removed from <collection> in <v>: <warning text>`.

### 7.3 ansible_module_search

```ts
{
  query: z.string().max(256).optional(),   // case-insensitive substring/token match on name and short description
  collection: z.string().max(256).optional(),   // namespace.name
  type: z.string().max(32).optional().default("module"),
  dir,
  limit: z.number().int().min(1).max(500).optional().default(50),
}
```

Annotations: READ_ONLY_LOCAL. Command: `ansible-doc -l -j -t <type> [collection]`. The output is a flat
`{fqcn: short_description}` object (`doc/list-module-ansible.posix.json`) and is cached per (type, collection,
fingerprint). Results are ranked: exact name, then name prefix, then name token, then description match. With no
query and no collection, the tool answers `pass query or collection (N <type> plugins installed)`.

Output: `N matches for 'firewall' (module):`, one line per match `ansible.posix.firewalld - Manage arbitrary
ports/services with firewalld`, ending with `... M more, narrow the query`.

### 7.4 ansible_check_task_args (centerpiece)

```ts
{
  task: z.string().max(100_000).optional(),    // YAML: one task mapping, or a list of tasks
  file: z.string().max(4096).optional(),       // tasks file / playbook / role tasks path relative to dir
  line: z.number().int().min(1).max(1_000_000).optional(),  // only the task whose span contains this line
  dir,
}
```

Exactly one of `task` / `file` is required; otherwise plain text. A playbook file checks every play's `tasks`,
`pre_tasks`, `post_tasks` and `handlers`, and `block`/`rescue`/`always` are recursed into. Annotations:
READ_ONLY_LOCAL. Only `ansible-doc --json` runs (batched across all tasks, F1/F2), plus the keyword list.

**Parsing.** Use the `yaml` npm package (eemeli, ISC, no deps) with `version: "1.1"` (F5), `!vault` and `!unsafe`
custom tags, and `keepSourceTokens`/ranges for line numbers. Duplicate keys are reported (Ansible warns about them).

**Checks** per task, against the installed docs:
1. Action resolution (6.2). Problems: `no module/action`, `conflicting action statements: a, b` (Ansible's own
   wording), not installed, tombstoned, or redirect to an uninstalled collection (as in 7.2).
2. Unknown option: not in options or any alias. `_raw_params` is allowed for free-form modules (`command`, `shell`,
   `raw`, `script`, `win_command`, `win_shell`, `include_vars`, `add_host`, `group_by`, `set_fact`, `meta`,
   `import_*`, `include_*`). `set_fact`'s keys are free.
3. Missing required (aliases count as set). `_terms` is ignored for lookups.
4. Choices: only for literal values. Any string containing `{{` or `{%` is "templated, not checked". YAML 1.1
   booleans are compared as Ansible does: a choice list of strings `['yes','no']` vs a bool value is reported with
   the quoting hint.
5. Type: Ansible's conversions:
   * `bool` accepts `yes no true false on off 1 0 y n t f`, case-insensitive, and the bools/ints 0/1
   * `int` accepts ints and numeric strings
   * `float`
   * `list` accepts lists and comma-separated strings
   * `dict` accepts mappings, `k=v` strings and JSON strings
   * `str` accepts anything scalar, with a warning on a non-string scalar only when it is a YAML 1.1 coercion (bool
     or octal int)
   * `path`, `raw`, `jsonarg`, `json`, `bytes`, `bits` are lenient
   * `elements` are checked inside lists
6. Suboptions: recursed for `dict` and `list` + `elements: dict`.
7. `mode` given as a YAML int: `mode 0755 is the octal integer 493 in YAML 1.1; quote it ("0755")`. This is the
   classic bug, and only applies to options named `mode` of type `raw`/`str`. A string mode (quoted, or any
   key=value one) is read by AnsibleModule as `int(mode, 8)`, then as symbolic: `755`, `0755`, `0o755` and
   `u=rwx,go=rx` are all 0755; a string that is neither (`493`, `0x1ed`) fails the task with "mode must be in octal
   or symbolic form" and is reported (`mode '493' is neither octal nor symbolic ...`).
9. Key=value form (`file: path=/x mode=755`, `action: file ...`): parse_kv yields strings, so the YAML 1.1 hints do
   not apply there (verified against ansible-core 2.21.5): `mode=755` is 0755, not decimal 755 (no hint);
   `state=off` is the string `off` (a plain choice error, no boolean hint); `backup=off` converts to a bool like any
   bool string; `content=yes` stays the string `yes`. Only the string-mode check (7) and the ordinary choice/type
   checks run on kv values.
8. Deprecated options or aliases, when the docs carry them.

Always printed when relevant: `not checked: cross-option rules (mutually_exclusive, required_if, ...) and
argument_spec-only deprecations are not in ansible-doc output (F3); ansible_lint_summary's args[module] covers them
for modules without an action plugin.` For a module with `has_action` it adds `ansible-lint skips this module
(action plugin)`.

Expected output, `file: playbooks/tasks/bad_args.yml`. The findings were derived by hand from the real docs
(`doc/copy.json`, `doc/posix-mount-1.5.4.json`, `doc/file.json`, `doc/ufw-short-name.json`), and the lint results
from `lint/bad-args.codeclimate.json`:

```
playbooks/tasks/bad_args.yml: 7 tasks checked against installed docs (ansible-core 2.21.5): 5 problems in 3 tasks
  :3 ansible.builtin.copy [has action plugin; ansible-lint skips its arguments]
    unknown option owner_name (line 7)
    unknown option state (line 9)
    backup (line 8): expected bool, got a string that is not a boolean ('maybe')
  :12 ansible.posix.mount
    missing required option path (aliases: name)
  :18 ansible.builtin.file (key=value form): ok (dest is an alias of path)
  :21 ansible.builtin.copy: ok by docs [not checked: src and content are mutually exclusive in the module's argument_spec, which ansible-doc does not expose]
  :27 community.general.git_config: ok by docs [lint reports list_all as deprecated (argument_spec only)]
  :32 ansible.builtin.apt: ok; 2 templated values not checked (state, update_cache)
  :38 community.general.ufw (from short name ufw)
    proto (line 41): 'tcpx' is not one of any|tcp|udp|ipv6|esp|ah|gre|igmp
not checked: cross-option rules (mutually_exclusive, required_if, ...) and argument_spec-only deprecations ...
```

The `[lint reports ...]` hint appears only if the caller also ran ansible_lint_summary. It is not computed here.
The fixture test asserts the problem lines, not the hint.

### 7.5 ansible_role_interface

```ts
{
  role: z.string().max(256),   // local role name, path relative to dir, or ns.collection.role
  dir,
  entry_point: z.string().max(128).optional(),   // default: all
  description_chars: z.number().int().min(0).max(2000).optional().default(160),
}
```

Annotations: READ_ONLY_LOCAL.

**Sources:**
* `ansible-doc --json -t role -r <roles_path...> <role>`, or `-t role <fqcn>` for a collection role. The output is
  `{role: {collection, entry_points: {<ep>: {short_description, description[], author, options}}, path}}`
  (`doc/role-webapp.json`).
* `defaults/main.yml` (or `defaults/main/` dir, or `main.yaml`), read by the server.
* `meta/main.yml` `dependencies` (string or `{role, vars, when}`) and `galaxy_info.min_ansible_version` /
  `platforms`.
* `vars/main.yml` variable names only, with a note that they are high-precedence and cannot be overridden by
  play vars.

Resolution: `roles_path` from the config dump, then `<dir>/roles`, then a path. If ansible-doc fails for a local
role, the server falls back to reading `meta/argument_specs.yml` itself, with the same YAML 1.1 reader. The fallback
also covers argument specs embedded in `meta/main.yml` (`argument_specs:` key).

Output (from `doc/role-webapp.json` + `roles/webapp/defaults/main.yml`):

```
role webapp (local, roles/webapp): 2 entry points, 5 defaults, 1 dependency
entry point main - Install and configure the web application
  webapp_server_name (str) [required] - Public DNS name.
  webapp_port (int) [default: 8080] - Port nginx listens on.
  webapp_tls_mode (str) [default: "self_signed"] [choices: false|self_signed|acme] - How the certificate is obtained.
    WARNING choice false comes from unquoted 'off' in meta/argument_specs.yml (YAML 1.1); quote it
  webapp_admin_password (str) [no_log] - Initial admin password.
  webapp_upstreams (list of dict) - Backend servers.
    host (str) [required]
    port (int) [default: 9000]
entry point configure - Only (re)write configuration files
  webapp_port (int) [default: 8080]
defaults (defaults/main.yml):
  webapp_port = 8080
  webapp_tls_mode = "self_signed"
  webapp_admin_password = (no_log)
  webapp_upstreams = []
  webapp_packages = ["nginx","python3-venv"]
  [not in argument_specs: webapp_packages]
dependencies: common (vars: common_timezone)
```

The "not in argument_specs" line flags defaults that are not part of the documented interface. Required options that
have a default are flagged too (`[required but has a default in defaults/main.yml]`). Ansible's role validation
treats `required` as "must be defined", and a default satisfies it.

### 7.6 ansible_inventory

```ts
{
  dir,
  inventory: z.string().max(4096).optional(),   // source relative to dir; default: ansible.cfg's inventory
  host: z.string().max(255).optional(),         // --host mode
  group: z.string().max(255).optional(),        // graph root
  vars: z.string().max(16).optional(),          // "none" | "names" | "values"; default names (list), values (host)
  limit: z.number().int().min(1).max(5000).optional().default(200),   // hosts listed
}
```

Annotations: READ_ONLY_LOCAL, or `openWorldHint: true` in the descriptions when dynamic inventory is allowed by env
(the annotation is static, so the description carries the caveat).

**Commands** (safety env, section 4.2):
1. `ansible-inventory --graph [group] [-i src]` always runs. It gives the structure and works even with vaults (F6).
2. `--list` (or `--host <h>`) runs for vars.
3. If that fails with `Attempting to decrypt but no vault secrets found` or `Decryption failed`, a whole-file vault is
   loaded somewhere. The server falls back:
   * re-run with `ANSIBLE_VARS_ENABLED=none` (verified: inventory-file vars only,
     `inventory/list-vars-plugins-off.json`)
   * then the server lists, with its own YAML reader, each `group_vars/` and `host_vars/` file next to each
     inventory source (and next to the playbook dir when the caller passed one): top-level key names and redacted
     values, with whole-file vaults shown as `<vaulted file, not read>`

   This is labelled `degraded: group_vars/host_vars merged by Ansible are unavailable because
   inventory/group_vars/all/vault.yml is a whole-file vault (ansible-mcp never supplies vault secrets); showing
   per-file contents instead, without precedence.`
4. Skipped dynamic sources (stderr `Failed to parse ... with 'ini' plugin` for files that `ini` could not read
   because `script`/`auto` are off) are summarized as `skipped (dynamic, not allowed): inventory/inv.sh,
   inventory/zz_constructed.yml`.
5. `--host` errors: `Could not match supplied host pattern` -> plain text `host 'nope' is not in this inventory`
   (`inventory/host-missing.stderr`, exit 5).

Output (`vars: names`, fixture with the whole-file vault moved aside, so `inventory/list.json`):

```
inventory inventory/hosts.yml (ansible-core 2.21.5): 3 hosts, 5 groups
@all:
  @ungrouped:
  @web: web1, web2
  @db: db1
  @staging:
    @web
vars (inventory-level only: group_vars/host_vars and inventory files; play, role and fact vars are not included):
  db1: ansible_host api_token app_env aws_secret_access_key db_password deploy_key_note ntp_server postgres_max_connections smtp_url token_ttl
  web1: ansible_become_password ansible_host ansible_user api_token app_env db_password http_port nginx_workers ntp_server smtp_url tls_key_passphrase token_ttl
  web2: ...
```

`host: web1` (`inventory/host-web1.json`):

```
host web1 (inventory inventory/hosts.yml): groups all, staging, web
  ansible_become_password = <vaulted>
  ansible_host = "10.0.0.11"
  ansible_user = "deploy"
  api_token = (redacted: secret-like name)
  app_env = "staging"
  db_password = "{{ vault_db_password }}" (template, not rendered)
  http_port = 8080
  nginx_workers = 4
  ntp_server = "pool.ntp.org"
  smtp_url = "smtp://mailer:(redacted)@mail.example.com:587"
  tls_key_passphrase = <vaulted>
  token_ttl = 3600
redacted: 2 vaulted, 1 by name, 1 URL password
vars are inventory-level only (play, role and fact vars are not included); values are not templated
```

Group membership comes from walking `--list` children: `all > staging > web` and `all > web`.

### 7.7 ansible_playbook_structure

```ts
{
  playbook: z.string().max(4096),        // relative to dir
  dir,
  inventory: z.string().max(4096).optional(),
  limit: z.string().max(512).optional(),
  tags: z.string().max(512).optional(),
  skip_tags: z.string().max(512).optional(),
  max_tasks: z.number().int().min(1).max(5000).optional().default(300),
}
```

Annotations: READ_ONLY_LOCAL. The description includes the R1 sentence.

**Steps:**
1. The lookup pre-scan (R1).
2. `ansible-playbook --syntax-check <pb>` (+ `-i`/`--limit`/`--tags`/`--skip-tags`). On failure, report every
   `[ERROR]` with its `Origin` file:line (F14) and stop.
3. `ansible-playbook --list-hosts --list-tasks --list-tags <pb>` with the same flags: one run, parsed per F13.
4. The static walk from 6.2 annotates each listed task with `module` and `file:line` when its (role, name) pair is
   unique in the walk. Ambiguous pairs get no annotation, not a guess. Dynamic includes are flagged `[dynamic:
   contents not expanded]`.
5. `[DEPRECATION WARNING]` blocks from both runs' stderr are collected with their Origin (F16).

Output (from `playbook/list-all.txt` + `playbook/syntax-check.stderr`):

```
playbook playbooks/site.yml (ansible-core 2.21.5): syntax ok, 3 plays, 15 tasks, hosts matched 3
play 1 'Web tier' hosts=web (2: web1, web2) tags [web] roles: webapp (+ dependency common)
  common : Timezone [web] community.general.timezone roles/common/tasks/main.yml:3
  common : Mount data [web] ansible.posix.mount roles/common/tasks/main.yml:7
  webapp : Validating arguments against arg spec 'main' - Install and configure the web application [always, web] (inserted by Ansible)
  webapp : Install packages [packages, web] ansible.builtin.apt roles/webapp/tasks/main.yml:3
  webapp : Open https [web] community.general.ufw roles/webapp/tasks/main.yml:10
  webapp : Firewalld service [web] ansible.posix.firewalld roles/webapp/tasks/main.yml:13
  webapp : Configure [config, web] ansible.builtin.include_tasks roles/webapp/tasks/main.yml:20 [dynamic: configure.yml not expanded]
  webapp : OS specific [web] ansible.builtin.include_tasks roles/webapp/tasks/main.yml:24 [dynamic, templated name]
play 2 'Database tier' hosts=db (1: db1) tags [db]
  Git identity [db, git] community.general.git_config playbooks/site.yml:17
  ...
play 3 'All hosts' hosts=all (3) tags []
  Ping ansible.builtin.ping playbooks/site.yml:59
tags: always, config, db, git, packages, tuning, web
deprecations seen while parsing (1):
  playbooks/site.yml:31 community.general.consul_acl has been deprecated. Use community.general.consul_token and/or community.general.consul_policy instead. This feature will be removed from collection 'community.general' version 10.0.0.
```

The tag-inheritance display drops tags that are only inherited from the play, so a task shows its own tags plus
`always`. The raw `TASK TAGS` line feeds the `tags:` summary.

### 7.8 ansible_config

```ts
{
  dir,
  all: z.boolean().optional().default(false),   // full dump instead of --only-changed
  filter: z.string().max(256).optional(),       // case-insensitive substring on setting name
  limit: z.number().int().min(1).max(2000).optional().default(300),
}
```

Annotations: READ_ONLY_LOCAL. Command: `ansible-config dump [--only-changed] --format json`, run without the safety
env (F11). The result is parsed as the array of `{name, origin, value}` plus the trailing `GALAXY_SERVERS` object.

Output (from `config/only-changed.json`, as a user without our scratch env would see it):

```
effective config for <dir> (ansible-core 2.21.5): config file <dir>/ansible.cfg
  DEFAULT_FORKS = 7  (ansible.cfg)
  DEFAULT_HOST_LIST = ["<dir>/inventory/hosts.yml"]  (ansible.cfg)
  DEFAULT_ROLES_PATH = ["<dir>/roles"]  (ansible.cfg)
  HOST_KEY_CHECKING = false  (ansible.cfg)
  INTERPRETER_PYTHON = "auto_silent"  (ansible.cfg)
  RETRY_FILES_ENABLED = false  (ansible.cfg)
galaxy servers: (none configured)
```

Origins are shortened: the cfg path becomes `ansible.cfg` when it is the detected config file, otherwise the full
path; `env: X` is kept; `default` only appears with `all`. The galaxy-servers fixture renders
`hub: url=https://hub.example.com/api/galaxy/content/published/ token=(redacted: galaxy credential)`. When the
server set `ANSIBLE_CONFIG` itself (3.3), the header says so. Settings the safety env will override in other tools
are flagged `[overridden by ansible-mcp in other tools]`. That covers `DEFAULT_VAULT_PASSWORD_FILE`,
`DEFAULT_VAULT_IDENTITY_LIST`, `INVENTORY_ENABLED` and `VARIABLE_PLUGINS_ENABLED`.

### 7.9 ansible_collections

```ts
{
  dir,
  requirements: z.string().max(4096).optional(),   // default: requirements.yml, collections/requirements.yml, roles/requirements.yml (all found)
  include_extras: z.boolean().optional().default(false),
}
```

Annotations: READ_ONLY_LOCAL.

**Commands:** `ansible-galaxy collection list --format json`, `ansible-galaxy role list` (text, deduped, F12), and the
config dump for COLLECTIONS_PATHS / DEFAULT_ROLES_PATH order.

**Requirements parsing.** The file may be a list of roles (legacy) or a mapping with `collections` and `roles`.
Entries are strings or mappings with `name`, `version`, `source`, `type` (galaxy, git, url, file, dir, subdirs) and
`signatures`. Non-galaxy types are reported as `not checked (type git)`.

**Constraint evaluator** (galaxy semantics): comma = AND, operators `==`, `!=`, `>=`, `>`, `<=`, `<`, and `*` (any).
A bare version means `==`. A pre-release satisfies only constraints that name a pre-release.

Output (fixture; from `galaxy/collection-list.json` and `galaxy/role-list.txt`):

```
requirements.yml: 3 collections, 1 role (collections paths: <user path> (inside WSL))
collections:
  community.general >=9.0.0,<10.0.0: installed 9.5.2 ok
  ansible.posix 2.0.0: installed 1.5.4 VIOLATES (requirements.yml:5)
  community.docker >=3.0.0: MISSING (requirements.yml:7)
roles:
  geerlingguy.ntp 2.3.1: MISSING (requirements.yml:10)
shadowed: (none)
summary: 1 ok, 1 violation, 2 missing
```

Shadowing (from `galaxy/collection-list-shadowed.json` with real search order): `ansible.posix: 2.0.0 at <target>
(effective, first in COLLECTIONS_PATHS), also 1.5.4 at <user>`. Extras (installed, not required) are counted, or
listed with `include_extras`. The site-packages `ansible` bundle counts as one line, `N collections from the ansible
package` (a `site-packages` or Debian `dist-packages` dir holding `ansible_collections`, either separator).

Path matching is separator-agnostic (`collectionPathKey`): `\` and `/` are equal, repeated/trailing separators and
a trailing `ansible_collections` segment are dropped (Ansible accepts a COLLECTIONS_PATHS entry with or without it),
`\\wsl.localhost\<distro>\x` / `\\wsl$\<distro>\x` is its Linux path `/x`, and a drive path `C:\x` matches its
WSL translation `<mount root>c/x` (the root learned from `wslpath`, `/mnt/` until then) case-insensitively. Linux
paths stay case-sensitive.

### 7.10 ansible_lint_summary

```ts
{
  dir,
  paths: z.array(z.string().max(4096)).max(50).optional(),   // relative to dir; default: the whole project (lint's own discovery)
  profile: z.string().max(32).optional(),                    // min|basic|moderate|safety|shared|production
  max_locations: z.number().int().min(0).max(500).optional().default(5),   // per rule
}
```

Annotations: READ_ONLY_LOCAL (`--offline`: lint never installs requirements). The description includes the R1
sentence and "never fixes anything; ADT MCP's ansible_lint fixes".

Command: `ansible-lint --offline -f codeclimate [-q] [--profile p] [paths...]`, cwd = dir. Exit 0 or 2 is normal
(F17). Any other exit code, or unparseable stdout, is an error that carries stderr. The summary line on stderr
gives the file counts.

Output (from `lint/project.codeclimate.json` + `lint/project.stderr`):

```
ansible-lint 26.10.1 (offline): 7 failures, 2 warnings in 19 files
fqcn[action] x3 (failure, formatting) - Use FQCN for module actions
  playbooks/tasks/bad_args.yml:38, roles/common/tasks/main.yml:7, roles/webapp/tasks/main.yml:10
no-free-form x2 (failure, syntax/risk)
  playbooks/tasks/bad_args.yml:17, roles/webapp/tasks/main.yml:9
args[module] x2 (warning, experimental) - missing required arguments: path | value of proto must be one of: ...
  playbooks/tasks/bad_args.yml:11, playbooks/tasks/bad_args.yml:37
yaml[truthy] x1 (failure) roles/webapp/meta/argument_specs.yml:19
risky-file-permissions x1 (failure) playbooks/tasks/bad_args.yml:20
top files: playbooks/tasks/bad_args.yml (5), roles/webapp/tasks/main.yml (2), roles/common/tasks/main.yml (1), roles/webapp/meta/argument_specs.yml (1)
lint warnings (not violations): inventory/group_vars/all/vault.yml could not be decrypted (expected: no vault secrets)
```

Every count and location in this example is taken from the fixture. Lint reports some rules at a task's `- name`
line (11, 17, 20, 37) and others at the action key (38); the summary passes lint's lines through unchanged.

### 7.11 ansible_upgrade_impact

```ts
{
  collection: z.string().max(256),
  version: z.string().max(64),
  dir,
  playbooks: z.array(z.string().max(4096)).max(50).optional(),   // default: detected playbooks
  syntax_check: z.boolean().optional().default(true),
  include_unused: z.boolean().optional().default(false),          // removed/tombstoned/deprecated content the project does not use (target metadata-dump), capped at 200 lines
}
```

Annotations: `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true`. The design is
in section 6. `include_unused` uses `ansible-doc --metadata-dump --no-fail-on-errors <collection>` for both sides
(F19: 4.7 s, 6.6 MB each), which is the same data the scratch differ used.

### 7.12 Caching

- **Fingerprint** = sha256 of (exec target id [prefix + bin dir], `ansible --version` first line, COLLECTIONS_PATHS,
  `ansible-galaxy collection list --format json` stdout). It is recomputed at most every 30 s, inside a tool call.
  Installing a collection therefore takes effect within 30 s, and two cheap calls (about 0.5-1 s total in WSL) are
  the price.
- **In memory**, keyed by fingerprint: ansible-doc results per (type, name), `-l -j` listings, the keyword list (per
  core version), the WSL mount root and Ansible-side HOME (per process). There is no disk cache for docs in v0.1.
  The fingerprint calls cost about the same as a doc call, so a disk cache would not pay for itself.
- **No caching** for inventory, config, playbook structure, lint or collections reports. They describe mutable files
  and must be fresh (the terraform-cwd-mcp state rule).
- **The upgrade target cache** lives on disk on the Ansible side (6.3) and is never evicted automatically.

## 8. Test plan

**Unit** (pure modules; no Ansible needed). These run against the fixtures:
- `ansibleDoc.ts`: parse every `doc/*.json` (key vs plugin_name, filename -> collection path, option flags, suboptions,
  `has_action`). Classify the missing/redirect-missing/tombstone stderr (F2), and the batch tombstone retry.
- `checkArgs.ts`: the 7.4 expected problems on `bad_args.yml` + `doc/*.json` + `doc/keywords.json`, exactly. Plus:
  YAML 1.1 cases (`off`, `yes`, `0755`), k=v parsing (quotes, `\=`, `_raw_params`), templated values skipped, suboptions,
  `elements`, aliases satisfying required, conflicting actions, `action:`/`local_action:` forms, block recursion,
  duplicate keys.
- `inventory.ts`: render `inventory/list.json`, `host-web1.json` and `graph.txt` to the 7.6 text. The fallback path
  uses `list-no-vault-secret.stderr` + `list-vars-plugins-off.json` + the per-file reader on `project/`. Skipped-source
  summary from `never-execute/inventory-dynamic-disabled.stderr`, and the unsafe-marker unwrap from
  `inventory-dynamic-enabled.json`.
- `redact.ts`: zero `FIXTURE-SECRET`/`FIXTURE-plain` in every renderer's output over the fixtures (including
  `list-WITH-vault-password.json`, which must still redact `FIXTURE-SECRET-01` by name, because `vault_db_password`
  is secret-like). Also the Ansible key list, the `vault_` prefix rule with `vault_addr` visible, URL userinfo,
  `$ANSIBLE_VAULT;` text, galaxy credentials.
- `playbook.ts`: parse `playbook/list-all.txt`, `list-tasks-tags-db.txt`, the syntax-check stderr Origins, and
  `never-execute/list-tasks.txt` (raw template in a task name). Plus the lookup pre-scan on `hostile/play.yml`
  (refused; 3 play-level hits).
- `config.ts`: `config/*.json` including the trailing GALAXY_SERVERS object and the credential redaction.
- `collections.ts`: requirements parsing, the constraint evaluator table, shadowing from
  `collection-list-shadowed.json` with an explicit COLLECTIONS_PATHS order, `role-list.txt` dedupe.
- `lint.ts`: codeclimate parsing (both location shapes), grouping, SARIF ignored, stderr summary.
- `upgrade.ts`: usage collection on `project/` (resolving `ufw` and `mount` through injected doc results). Rules on
  `upgrade/docs-installed.json` vs `docs-target.json` + runtime excerpts give exactly the 6.6 findings for both
  collections. Hand-built docs cover the unit-test-only rules (alias dropped, plugin removed without routing, redirect
  to an installed collection, requires_ansible BLOCKED, non-convertible type change).
- `wsl.ts`: argv construction (`--cd` spliced before `--exec`, `env -u`, `K=V`), prefix validation (refuses `--`),
  path translation both ways with a non-default mount root, UNC acceptance rules, and UTF-16 error decoding (bytes
  from `wsl/wsl-exec-probe.txt`).
- Tool names vs the ADT/PyPI collision list (section 0).

**Server** (`server.test.ts`, InMemoryTransport): 11 tools listed, with annotations, `maxLength` on every string,
titles and descriptions. Every tool end to end with an injected `runAnsible` that replays fixture outputs by argv.
`isError` appears only for real failures.

**Integration** (real Ansible; skipped when it is absent: native `ansible-doc` on PATH, or on win32
`ANSIBLE_MCP_TEST_PREFIX`/`ANSIBLE_MCP_TEST_BIN_DIR`). These use temp copies of `project/` and `hostile/` on the
Ansible side's native filesystem, plus one DrvFs copy on win32:
- Every tool on `project/`. Snapshot `dir` (paths, sizes, mtimes) before and after: identical.
  `~/.ansible/galaxy_cache` untouched.
- `hostile/`: run every tool and assert the markers. Never touched: `vault-password-script`, `inventory-script`,
  `constructed-compose`, `group-vars-lookup`, `task-name-lookup`, `include-lookup`. Before a playbook is spawned, the
  lookup pre-scan refuses `play.yml`. With `ANSIBLE_MCP_ALLOW_PLAY_LOOKUPS=1`, the R1 markers appear (documented
  residue), and the test pins exactly that set, so any change in Ansible's behaviour surfaces.
- Vault: whole-file vault, so `ansible_inventory` degrades as specified. No sentinel appears in output. A cfg with
  `vault_password_file` pointing at the hostile script does not run it.
- DrvFs (win32 only): a copy under `%TEMP%`. `ansible_config` reports the cfg (3.3 rule), and without the rule (a
  test hook) it reports CONFIG_FILE null.
- `ansible_upgrade_impact`: ansible.posix 1.5.4 -> 2.0.0 (small, about 1.7 MB) end to end into a temp cache root,
  then a second call offline (`HTTPS_PROXY=http://127.0.0.1:9` forwarded via `ANSIBLE_MCP_PASS_ENV`) answers from
  the cache. community.general 9.5.2 -> 12.0.0 is opt-in behind `ANSIBLE_MCP_TEST_BIG=1` (about 56 MB, 30-50 s).
  Asserts: findings equal 6.6, the user's collections path is unchanged, and no `.tmp-*` dirs are left.
- Galaxy errors: a bad version, and offline via the dead proxy, map to the 6.3 messages.
- WSL (win32 only): the argv round-trip from `wslprobe.mjs` through the real `runAnsible` (`printf` as the "tool"),
  kill on timeout, a bad distro, a missing binary.

Pre-commit gates (house standard): `npm run lint:fix`, `npx tsc --noEmit`, `npm test`, `npm run build`,
`npm run check:compliance` (grade A).

## 9. Package shape (from terraform-cwd-mcp; differences only)

- **Dependencies:** `@modelcontextprotocol/sdk`, `zod`, `yaml` (eemeli, ISC, zero deps; YAML 1.1 + custom tags +
  ranges). There is no tree-sitter and no vendor/ dir.
- **`src/`:**
  * `index.ts`, `server.ts`, `tools.ts`
  * `exec.ts`: runAnsible, prefix, WSL argv, error decoding, safety env
  * `paths.ts`: dir resolution, UNC rules, translation
  * `yaml.ts`: the 1.1 reader with line numbers
  * `project.ts`: detection and the static walk/usage collection
  * `ansibleDoc.ts`, `checkArgs.ts`, `role.ts`, `inventory.ts`, `playbook.ts`, `config.ts`, `collections.ts`,
    `constraints.ts`, `lint.ts`, `upgrade.ts`, `redact.ts`
- `bin/ansible-mcp.mjs`, `scripts/runtime.mjs`, `scripts/typecheck.mjs`, `scripts/check-oam-floor.mjs` and
  `scripts/lint.mjs` are ported as they are, with env names `ANSIBLE_MCP_RUNTIME` and `ANSIBLE_MCP_ALLOW_STALE_OAM`.
  The oam floor uses the same policy (the latest verified oam, 0.19.1 today). The reason the floor matters carries
  over: spawns pass an explicit env that deletes variables (`env -u` on the WSL side; natively, `ANSIBLE_VAULT_*`
  overrides replace user values).
- There is no `build-binary.mjs` and no `sea-config.json` (npm only). `package.json` has `"private": true`.
- Env vars (CLAUDE.md table):
  * `ANSIBLE_MCP_DIR`, `ANSIBLE_MCP_COMMAND_PREFIX`, `ANSIBLE_MCP_BIN_DIR`, `ANSIBLE_MCP_PATH_STYLE`,
    `ANSIBLE_MCP_PASS_ENV`, `ANSIBLE_MCP_TIMEOUT_MS`
  * `ANSIBLE_MCP_CACHE` (server side), `ANSIBLE_MCP_REMOTE_CACHE` (Ansible side, prefix mode)
  * `ANSIBLE_MCP_ALLOW_DYNAMIC_INVENTORY`, `ANSIBLE_MCP_ALLOW_PLAY_LOOKUPS`
  * `ANSIBLE_MCP_RUNTIME`, `OAM_BIN`, `OAM_INSTALL_DIR`, `ANSIBLE_MCP_ALLOW_STALE_OAM`
- `server.json`, the README and CHANGELOG list the 11 tools. The README follows caddy-mcp's conventions and leads
  with the authority split and a WSL setup block:
  `{"ANSIBLE_MCP_COMMAND_PREFIX": "[\"wsl.exe\",\"-d\",\"Ubuntu\",\"--exec\"]", "ANSIBLE_MCP_BIN_DIR":
  "/home/me/.venvs/ansible/bin"}`.

## 10. Open questions (decide during implementation; none blocks the design)

1. `ansible_playbook_structure` on a large monorepo can spend 10+ s in WSL for syntax-check plus list. If that is
   common, add `syntax_check: false` (list-* fails with the same error anyway).
2. Should the static usage walk (6.2) also follow `include_role`/`import_role` into **collection** roles? v0.1 says
   no: their tasks belong to the collection, and the upgrade of that collection covers them. The option is noted for
   v0.2.
3. Callback plugins named in cfg `callbacks_enabled` should not load for `--syntax-check`/`--list-*`, because no
   TaskQueueManager is created. That was not probed. The integration test adds a marker callback to `hostile/` to
   pin it down before release.

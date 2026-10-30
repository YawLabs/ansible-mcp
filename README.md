# @yawlabs/ansible-mcp

[![Add to Yaw MCP](https://yaw.sh/yaw-mcp-button.svg)](https://yaw.sh/mcp/install?name=Ansible&command=npx&args=-y%2C%40yawlabs%2Fansible-mcp&description=Ansible%20checkout%20truth%3A%20module%20specs%2C%20task%20args%2C%20roles%2C%20inventory%2C%20plays%2C%20upgrade%20impact&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Fansible-mcp)

One click adds this to your local Yaw MCP config so it's available in every Yaw Terminal session. Or install manually below.

**What is actually true in THIS Ansible checkout on THIS control node: the exact option specs of the modules you have INSTALLED (so coding agents stop writing options that do not exist in your collection version), task-argument checks, role interfaces, inventory structure and vars (redacted), play structure, effective config, requirements drift, and what a collection upgrade would break in your tasks.** It is read-only: it never runs a play, never runs `--check`, never connects to a managed host and never supplies a vault secret. It complements Red Hat's servers rather than replacing them: AAP MCP answers what is true in the controller, ADT MCP takes actions (lint `--fix`, navigator runs, scaffolding, EE builds). Run them together.

[![npm version](https://img.shields.io/npm/v/@yawlabs/ansible-mcp)](https://www.npmjs.com/package/@yawlabs/ansible-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Built and maintained by [Yaw Labs](https://yaw.sh).

## Why this one?

Your checkout has `community.general 9.5.2`; the model's training data has whatever version it saw most. Agents then write `git_config: list_all: true` (removed in 11.0.0), forget `name` (required since 12.0.0), or set `state: present` on `rhsm_repository` (no longer accepted). The VS Code language server knows the exact specs, but only a person in the editor sees them. This server lets the agent check *before* it writes, against what is installed.

- **Installed, not latest** -- the source of truth is `ansible-doc --json` run against your collections paths, with redirects (`ufw` -> `community.general.ufw`) and tombstones resolved.
- **Checks what lint skips** -- `ansible-lint`'s `args` rule skips modules with action plugins (`copy`, `template`); `ansible_check_task_args` catches their unknown options and bad values, and says plainly which cross-option rules ansible-doc cannot express.
- **YAML 1.1 aware** -- Ansible parses YAML 1.1, so unquoted `off` is `false` and `0755` is the integer 493. The server reads YAML the same way and says when that is probably a bug.
- **Read-only by construction** -- configured vault password scripts never run (a server-owned dummy password file replaces them), script and plugin inventory sources are off by default, and play-level lookups are refused before Ansible parses a playbook (as is any playbook or lint target the pre-scan cannot fully read).
- **Collection upgrade impact** -- downloads only the target version into its own cache and diffs the arg specs of the modules your tasks actually use, tied to file:line.
- **macOS, Linux, and Windows through WSL** -- Ansible has no Windows control node; on Windows the server spawns it through `wsl.exe --exec` (no shell anywhere).

## Tools

| Tool | What it does |
|---|---|
| `ansible_project_info` | ansible-core version, effective config file, collections and roles paths, installed `ansible-*` binaries, detected playbooks, inventories (with whole-file vault count), roles and requirements files. Call this first. |
| `ansible_module_doc` | Every option of one module or plugin as installed: type, required, default, choices, aliases, suboptions, deprecations, `no_log`, the providing collection version, `[has action plugin]`, returns and (optionally) examples. |
| `ansible_module_search` | Find installed modules/plugins by name or description, ranked exact, prefix, token, then description. |
| `ansible_check_task_args` | Check inline task YAML or a tasks file / playbook against the installed docs: unknown options, missing required ones (aliases count), bad choices and types, suboptions, `mode: 0755`, deprecated options, duplicate keys. Never claims "valid": it names what ansible-doc cannot check. |
| `ansible_role_interface` | A role's argument_specs entry points and options, defaults (redacted, `no_log` honoured), undocumented defaults, dependencies, vars names, galaxy_info. Local roles and `ns.collection.role`. |
| `ansible_inventory` | Groups, hosts, and inventory-level vars (names or values), always redacted. Whole-file vaults degrade to a per-file view instead of failing. |
| `ansible_playbook_structure` | `--syntax-check`, then plays, matched hosts, tasks with module and file:line, tags, and the deprecation warnings Ansible printed while parsing. |
| `ansible_config` | Effective config with origins (ansible.cfg, env, default); galaxy credentials always redacted; settings the server overrides for safety are flagged. |
| `ansible_collections` | requirements.yml vs installed: ok / VIOLATES / MISSING with file:line, galaxy constraint semantics, and shadowed copies across collections paths. |
| `ansible_lint_summary` | `ansible-lint --offline` grouped by rule with counts, severities and locations. Never fixes. |
| `ansible_upgrade_impact` | What breaks in this project's tasks if a collection moves to an exact version: removed/moved modules (runtime.yml redirects and tombstones), removed options and aliases, newly required options, dropped choices, type and default changes, requirements constraints, `requires_ansible`, an optional syntax-check against the target, and a verdict. |

Every tool takes an optional `dir` (the project). Tool names carry an `ansible_` prefix and never reuse ADT MCP's names (`ansible_lint`, `ansible_navigator`, ...), so both can sit behind one aggregator.

### Division of authority

| Question | Authority |
|---|---|
| Controller jobs, job templates, controller inventories, RBAC | AAP MCP |
| Scaffold content, `ansible-lint --fix`, run via ansible-navigator, set up a venv or EE | ADT MCP |
| Interactive editing for a person | VS Code Ansible extension (language server) |
| Generate new content from intent | Ansible Lightspeed |
| Execute modules against hosts | not this server |
| Installed specs, task-argument validity, role interfaces, local inventory, play structure, effective config, dependency drift, collection upgrade impact | **ansible-mcp** (read-only) |

### What is read-only, and what touches the network

- **Never run:** plays, modules, `--check`, `--diff`, fact gathering. The only Ansible commands are `ansible --version`, `ansible-config dump`, `ansible-doc`, `ansible-inventory --list/--host/--graph`, `ansible-playbook --syntax-check/--list-*`, `ansible-galaxy collection list` / `role list`, `ansible-lint --offline`, and (only in `ansible_upgrade_impact`) `ansible-galaxy collection install --no-deps -p <server cache>`.
- **Never written:** your project, your collections and roles paths, requirements files, and anything inside an existing `~/.ansible`. Ansible's local temp, galaxy cache and (when you have none) galaxy token file are redirected to the server's cache. The one residue: Ansible creates an empty `~/.ansible` when it does not exist, and ansible-lint creates empty `~/.ansible/roles` / `~/.ansible/collections` when they are missing.
- **Vault:** no secret is ever supplied, and a `vault_password_file` / `vault_identity_list` script named in ansible.cfg never runs (it is replaced by a server-owned file holding a random password). Inline `!vault` values print as `<vaulted>`; whole-file vaults are listed, not read.
- **Dynamic inventory** (script, constructed, cloud plugins) runs code and calls APIs, so it is off unless `ANSIBLE_MCP_ALLOW_DYNAMIC_INVENTORY=1`; skipped sources are named in the answer.
- **Residual risk, stated:** `ansible-playbook --syntax-check` (and ansible-lint, which runs it) evaluates Jinja in play-level `name`, `hosts` and `vars_files` and imports playbook-adjacent `vars_plugins/`. Treat `dir` as code you would run `--syntax-check` on. Lookups in those fields are refused before Ansible sees them unless `ANSIBLE_MCP_ALLOW_PLAY_LOOKUPS=1`, and local plugin files are listed in the answer.
- **Redaction** (`ansible_inventory`, `ansible_role_interface`, `ansible_config`, lint messages): vault markers, plus any string equal to a hidden one, plus values under secret-like names (`ansible_become_password`, `api_token`, `vault_db_password`, ... but not `vault_addr` or `private_key_file`), plus secret-shaped strings (private keys, JWTs, GitHub/GitLab/Slack/npm tokens; URL passwords masked in place). Galaxy server tokens and passwords are always redacted. There is no "show secrets" switch.
- **Network:** only `ansible_upgrade_impact`, on a cache miss, to Galaxy or the servers in your ansible.cfg (`openWorldHint: true`). The cache is never evicted automatically; deleting it is safe.

Example `ansible_check_task_args` output (real docs, community.general 9.5.2):

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
  :32 ansible.builtin.apt: ok; 2 templated values not checked (state, update_cache)
  :38 community.general.ufw (from short name ufw)
    proto (line 41): 'tcpx' is not one of any|tcp|udp|ipv6|esp|ah|gre|igmp
```

Example `ansible_upgrade_impact` output (real 9.5.2 -> 12.0.0 docs):

```
upgrade community.general 9.5.2 -> 12.0.0 (major) for /work/site
target: requires_ansible '>=2.17.0' ok (ansible-core 2.21.5); dependencies: none; downloaded (cache: ...)
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

## Quick start

**1. Have ansible-core where the server can run it.** On macOS / Linux, `ansible-core` (and optionally `ansible-lint`) on `PATH`, or in a venv you point `ANSIBLE_MCP_BIN_DIR` at. On Windows, inside WSL:

```bash
# inside WSL (any distro); a venv under $HOME survives WSL restarts, /tmp does not
python3 -m venv ~/.venvs/ansible && ~/.venvs/ansible/bin/pip install ansible-core ansible-lint
```

**2. Add the server.** Claude Code, from the project:

```bash
# macOS / Linux
claude mcp add ansible -- npx -y @yawlabs/ansible-mcp@latest

# Windows (Ansible inside WSL)
claude mcp add ansible -e ANSIBLE_MCP_COMMAND_PREFIX='["wsl.exe","-d","Ubuntu","--exec"]' -e ANSIBLE_MCP_BIN_DIR=/home/me/.venvs/ansible/bin -- cmd /c npx -y @yawlabs/ansible-mcp@latest
```

Or add it to `.mcp.json` in the project (or anywhere, and set `ANSIBLE_MCP_DIR`):

macOS / Linux:

```json
{
  "mcpServers": {
    "ansible": {
      "command": "npx",
      "args": ["-y", "@yawlabs/ansible-mcp@latest"]
    }
  }
}
```

Windows (Ansible inside WSL):

```json
{
  "mcpServers": {
    "ansible": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@yawlabs/ansible-mcp@latest"],
      "env": {
        "ANSIBLE_MCP_COMMAND_PREFIX": "[\"wsl.exe\",\"-d\",\"Ubuntu\",\"--exec\"]",
        "ANSIBLE_MCP_BIN_DIR": "/home/me/.venvs/ansible/bin"
      }
    }
  }
}
```

> **Why the extra step on Windows?** Since Node 20, `child_process.spawn` cannot directly execute `.cmd` files (that's what `npx` is on Windows). Wrapping with `cmd /c` is the standard workaround.

**3. Restart your MCP client** and ask, for example: *"Add a task that opens port 8443 with ufw -- check the arguments against our installed collections first."*

### Windows and WSL, in detail

- The prefix must use `wsl.exe --exec` (or `-e`), never `--`: with `--`, WSL re-parses the arguments with bash and a value like `it's` breaks the command. The server refuses a prefix without `--exec`.
- Nothing from the Windows environment crosses into WSL. Variables the Ansible side needs (proxies, `ANSIBLE_COLLECTIONS_PATH`) are forwarded by name with `ANSIBLE_MCP_PASS_ENV`.
- Windows paths are translated with the mount root `wslpath` reports (`C:\work\site` -> `/mnt/c/work/site`). A project inside WSL works too: pass `dir` as `\\wsl.localhost\Ubuntu\home\me\site` (the distro must match the prefix's `-d`).
- On a Windows drive every folder looks world-writable to WSL, and Ansible then ignores `ansible.cfg`. When the project has one, the server sets `ANSIBLE_CONFIG` to it explicitly and says so.
- The server's Ansible-side cache lives under the WSL user's `~/.cache/ansible-mcp` (never `/tmp`, which WSL empties on restart).

## Tell your agent to use it

Paste this into the project's `CLAUDE.md` (or `AGENTS.md`):

```markdown
## Ansible

Module options drift between collection versions. Use the ansible MCP server:

- Call `ansible_project_info` once per session.
- Before writing or editing a task, call `ansible_module_doc` for its module, then
  run `ansible_check_task_args` on the task (or the file). Fix every problem it
  reports; quote values it flags as YAML 1.1 traps.
- Before using a role, read `ansible_role_interface`.
- Before bumping a collection in requirements.yml, run `ansible_upgrade_impact`.
- Never run plays, `--check` or `ansible-lint --fix` on your own; ask first.
```

## Configuration

All optional.

| Env var | Default | Purpose |
|---|---|---|
| `ANSIBLE_MCP_DIR` | the server's working directory | Project used when a tool call passes no `dir`. |
| `ANSIBLE_MCP_COMMAND_PREFIX` | (unset: native) | JSON array prepended to every Ansible command, e.g. `["wsl.exe","-d","Ubuntu","--exec"]`. A value not starting with `[` is split on whitespace. Required on Windows. |
| `ANSIBLE_MCP_BIN_DIR` | (unset: `PATH`) | Ansible-side directory holding `ansible-*` (a venv's `bin`). Also put first on the child's `PATH` (ansible-lint needs `ansible-playbook` next to it). |
| `ANSIBLE_MCP_PATH_STYLE` | `auto` | `wsl` or `native`. `auto` is `wsl` when the prefix starts with `wsl`/`wsl.exe`. Other prefixes (`ssh`, `docker exec`) get `env -C <dir> ...` and are best effort. |
| `ANSIBLE_MCP_PASS_ENV` | (unset) | Comma-separated names of server env vars to forward to the Ansible side in prefix mode. |
| `ANSIBLE_MCP_TIMEOUT_MS` | `120000` | Kill any Ansible command after this long (the upgrade download gets 3x). |
| `ANSIBLE_MCP_CACHE` | `~/.cache/ansible-mcp` | Server-side cache (and the Ansible-side one in native mode): the dummy vault file, local temp, upgrade targets. Safe to delete. |
| `ANSIBLE_MCP_REMOTE_CACHE` | `$HOME/.cache/ansible-mcp` on the Ansible side | The Ansible-side cache in prefix mode. |
| `ANSIBLE_MCP_ALLOW_DYNAMIC_INVENTORY` | (unset) | `1` re-enables script, constructed and plugin inventory sources (they run code and may call cloud APIs). |
| `ANSIBLE_MCP_ALLOW_PLAY_LOOKUPS` | (unset) | `1` lets playbooks with lookups in play-level `name` / `hosts` / `vars_files` be parsed (Ansible runs those lookups on this machine). |

**Runtime (oam or Node):**

The `ansible-mcp` command prefers [oam](https://oamjs.org) when it finds a
usable one and otherwise runs on Node. It never serves on an oam older than 0.19.1.

| Env var | Default | Purpose |
|---|---|---|
| `ANSIBLE_MCP_RUNTIME` | `auto` | `auto`: the newest oam at 0.19.1 or newer, else Node. `oam`: oam or exit with an error. `node`: always Node -- the escape hatch when a problem only shows up under oam. |
| `OAM_BIN` | (unset) | Path to the oam binary to use. Otherwise the launcher checks `OAM_INSTALL_DIR`, the installed locations (`~/.oam/bin`, and `%LOCALAPPDATA%\oam\bin` on Windows) and `PATH`, and takes the newest. |

An outdated oam is fixed with `oam self-update`. Under Yaw MCP, which runs servers
on oam by default, `yaw-mcp set <namespace> runtime=node` switches this server to
Node. There is no `--permission` sandbox option: the server spawns Ansible and
reads whatever directory a call names, so there is nothing narrow to grant.

## Requirements

- Node.js 20+
- ansible-core on the control node (verified with 2.21.5); ansible-lint for `ansible_lint_summary` (verified with 26.10.1)
- Windows: WSL with ansible-core installed in a distro, and `ANSIBLE_MCP_COMMAND_PREFIX` set. Without it, only `ansible_project_info` (static half) and `ansible_role_interface` (local files) answer; the rest say what to set.
- `ansible_upgrade_impact`: Galaxy (or your configured servers) reachable the first time a target version is requested; later runs for that version are offline

## Contributing

```bash
git clone https://github.com/YawLabs/ansible-mcp.git
cd ansible-mcp
npm install
npm run lint       # Biome check
npm run lint:fix   # Auto-fix
npm run build      # tsup bundle + declarations
npm test           # Vitest (integration tests run only when Ansible is reachable)
npm run typecheck  # oam check . when oam is installed, else tsc --noEmit
npm run check:oam-floor  # the oam floor agrees across the repo and matches the latest oam release
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, including release process.

## License

MIT

[![Follow @YawLabs on X](https://img.shields.io/badge/follow-%40YawLabs-000000?logo=x&logoColor=white)](https://x.com/YawLabs)

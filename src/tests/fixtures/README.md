# Test fixtures

Everything under `output/` is real output captured on 2026-10-15 with ansible-core 2.21.5, ansible-lint 26.10.1
(ansible-compat 26.10.0), Python 3.12.14, in a throwaway venv inside WSL2 Ubuntu (`/tmp/ansible-mcp-venv`, installed with
uv: `ansible-core` + `ansible-lint` only). Collections were installed into a scratch path with
`ANSIBLE_COLLECTIONS_PATH`, never into a home directory: ansible.posix 1.5.4 and community.general 9.5.2 as the
"installed" set, ansible.posix 2.0.0 and community.general 12.0.0 (plus 11.4.0, used only for the scratch differ) as
upgrade targets. Design and the findings drawn from these files: `docs/design.md`.

Commands ran in a copy of `project/` on the WSL ext4 filesystem (`/tmp/ansible-mcp-work/project`), so the absolute
paths inside the output are `/tmp/ansible-mcp-work/...`. Tests must treat those paths as data, not rewrite them.
`output/MANIFEST.tsv` lists every file with the exact command, the capture it came from and the exit code.

## Secrets

There are no real secrets anywhere. Every secret is a sentinel, so tests can assert that no tool output ever contains
`FIXTURE-SECRET` or `FIXTURE-plain`:

- `FIXTURE-SECRET-NN` -- values that are vault-encrypted in `project/` (01 and 04 in the whole-file vault
  `inventory/group_vars/all/vault.yml`, 02 and 03 as inline `!vault` strings), plus 05/06 in the galaxy-server
  config fixture (`output/config/galaxy-servers.ansible.cfg`, a token and a password that `ansible-config dump`
  prints in clear text).
- `FIXTURE-plain-*` -- deliberately UNencrypted secrets that only the key-name or value-shape redaction layers can
  catch (`api_token`, a URL password in `smtp_url`, `aws_secret_access_key`, a `ghp_`-shaped token under an innocent
  key name, a role default `webapp_admin_password`).

The vault password for `project/` is `FIXTURE-vault-password`. It is committed on purpose: the encrypted values are
sentinels, and the integration tests need it only to regenerate `output/inventory/list-WITH-vault-password.json`,
which exists to prove why the server never supplies a vault password (whole-file vaults come out decrypted).

## project/

The main fixture project, built to exercise every tool:

- `ansible.cfg` -- inventory, roles_path, forks = 7 (shows up in `ansible-config dump` with its origin).
- `inventory/hosts.yml` + `group_vars/all/{main,vault}.yml`, `group_vars/web.yml` (inline vault),
  `host_vars/web1.yml` (inline vault), `host_vars/db1/main.yml` (plain secret-like keys). Groups: web (web1, web2),
  db (db1), staging (child group web).
- `roles/webapp` -- `meta/argument_specs.yml` with two entry points (`main`, `configure`), a `no_log` option, nested
  `options`, and `choices: [off, ...]` that YAML 1.1 turns into boolean `false` (finding F5); `meta/main.yml`
  depends on `common`; `defaults/main.yml`; an `include_tasks` with a templated file name (not expanded by
  `--list-tasks`).
- `roles/common` -- `community.general.timezone` and the short name `mount` (redirected to `ansible.posix.mount`
  by ansible-core's builtin runtime).
- `playbooks/site.yml` -- three plays. Play 2 uses community.general modules chosen from the real 9.5.2 -> 12.0.0
  diff: `git_config` with `list_all` (removed in 12; `name` newly required), `proxmox_kvm` (redirected to the
  uninstalled community.proxmox), `consul_acl` (tombstoned in 10.0.0), `slack` (default of `prepend_hash` changed),
  `rhsm_repository state: present` (choice removed), plus `ansible.posix.sysctl`. The web role uses
  `ansible.posix.firewalld` (`masquerade` type str -> bool in 2.0.0) and the free-form `ufw: rule=allow ...` short
  name.
- `playbooks/tasks/bad_args.yml` -- a tasks file for `ansible_check_task_args`: unknown options, a non-boolean
  `backup`, a missing required option, a key=value task using an alias, src+content (mutually exclusive, which
  ansible-doc cannot express), an option deprecated only in the module's Python argument_spec, templated values,
  and a bad choice through a redirected short name. Expected findings are in `docs/design.md` section 7.4.
- `requirements.yml` -- community.general `>=9.0.0,<10.0.0` (satisfied by 9.5.2, excludes 12.0.0), ansible.posix
  `2.0.0` (violated by the installed 1.5.4), community.docker `>=3.0.0` (missing), role geerlingguy.ntp (missing).

## hostile/

The never-execute probe project. Every hook in it touches a marker file under `$ANSIBLE_MCP_MARK_DIR` (default
`/tmp/ansible-mcp-marks`) when Ansible runs it: a `vault_password_file` script named in `ansible.cfg`, a script
inventory source, a `constructed` inventory plugin config with a `pipe` lookup in `compose`, a `group_vars` value
with a `pipe` lookup, a playbook-adjacent `vars_plugins/` and `filter_plugins/` module, and `pipe` lookups in a
play's `name`, `hosts`, `vars_files`, a task name and an `include_tasks` file name. `output/never-execute/markers.tsv`
records which markers each command touched, with and without the server's safety environment. Scripts need their
executable bit (`vault-pass.sh`, `inventory/inv.sh`); git on Windows may not keep it, so the integration test sets it
on its temp copy.

## output/

| Dir | What |
|---|---|
| `version.txt` | `ansible --version` |
| `config/` | `ansible-config dump --only-changed` (JSON and text), the same with `ANSIBLE_FORKS` from env, and a galaxy-server config whose token/password the dump prints in clear |
| `doc/` | `ansible-doc --json` for builtin modules (FQCN and short name), a collection module, a module deprecated via meta/runtime.yml, a multi-module call, a lookup, a role (`-t role -r roles`), missing plugins, `-l -j` listings, and the task keyword docs (`-t keyword`) |
| `inventory/` | `--list`, `--host`, `--graph`, `--list --yaml`; the whole-file-vault failure, the inline-vault shape, `ANSIBLE_VARS_ENABLED=none` output, wrong / `/dev/null` vault password errors, and the decrypted-with-password output |
| `playbook/` | `--syntax-check`, `--list-tasks`, `--list-hosts`, `--list-tags`, all three at once, `--tags db`, and syntax-check on a tasks file |
| `galaxy/` | `collection list` (JSON and text, one collection, missing, shadowed across three paths), `role list`, and `collection install -p` errors (bad version, bad name, offline) and the already-installed answer |
| `lint/` | `ansible-lint --offline` codeclimate JSON and SARIF for the playbook, the whole project, and the bad-args tasks file, with stderr summaries |
| `upgrade/` | `ansible-doc --json` of the used modules from the installed and target versions, the target-side failure texts (redirect to an uninstalled collection, tombstone, a tombstone failing a whole batch), `--syntax-check` against the target, and the meta/runtime.yml of both versions (community.general as excerpts) |
| `never-execute/` | marker table and the outputs of the hostile project with dynamic inventory on and off |
| `wsl/` | `wslprobe.mjs` (Node, run on the Windows host) and its output: argv preservation through `wsl.exe --exec`, latency, env passing, `wslpath`, `--cd`, the DrvFs world-writable `ansible.cfg` behaviour, wsl.exe's own UTF-16 errors, kill propagation |

## Regenerating

Requires WSL (or Linux/macOS) with Python 3.12 and network access to Galaxy. Keep the distro alive while you work
(`wsl -d Ubuntu -- sleep 14400` in the background): when no WSL process is running the distro stops after a few
seconds and `/tmp` is emptied on the next start.

1. `uv venv /tmp/ansible-mcp-venv && VIRTUAL_ENV=/tmp/ansible-mcp-venv uv pip install ansible-core ansible-lint`
2. `export ANSIBLE_HOME=/tmp/ansible-mcp-work/home ANSIBLE_COLLECTIONS_PATH=/tmp/ansible-mcp-work/collections
   PATH=/tmp/ansible-mcp-venv/bin:$PATH NO_COLOR=1`
3. `ansible-galaxy collection install -p $ANSIBLE_COLLECTIONS_PATH 'ansible.posix:==1.5.4' 'community.general:==9.5.2'`
4. Targets: `ansible-galaxy collection install --no-deps -p <dir> '<name>:==<version>'` per target.
5. Copy `project/` to the Linux filesystem (on `/mnt/c` Ansible ignores `ansible.cfg`, finding F22), then run the
   commands in `output/MANIFEST.tsv`.

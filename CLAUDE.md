# ansible-mcp

MCP server answering "what is actually true in THIS Ansible checkout on THIS control node". 11 read-only tools, all prefixed `ansible_`: `ansible_project_info`, `ansible_module_doc`, `ansible_module_search`, `ansible_check_task_args`, `ansible_role_interface`, `ansible_inventory`, `ansible_playbook_structure`, `ansible_config`, `ansible_collections`, `ansible_lint_summary`, `ansible_upgrade_impact`. Design, the 25 findings from real Ansible runs that shaped it, and every expected output: `docs/design.md` (read it before changing behaviour).

Complements Red Hat's servers, never replaces them. Authority split (also in `INSTRUCTIONS` and the tool descriptions): AAP MCP owns controller state; ADT MCP owns actions (lint `--fix`, navigator, scaffolding, EE builds); this server owns installed specs, task-argument validity, role interfaces, local inventory, play structure, effective config, dependency drift and collection upgrade impact.

npm only, no SEA binary; `package.json` has `"private": true` until the first publish (remove it, and add `repository.id` to server.json once the GitHub repo exists, before the first `release.sh`).

## Architecture

- `src/index.ts` -- CLI entry point. `--version` / `-V`, else starts the stdio server.
- `src/server.ts` -- `INSTRUCTIONS`, `createAnsibleMcpServer(opts)`, `startServer()` (also sweeps stale upgrade temp dirs in the native cache), and re-exports every module as the library surface.
- `src/tools.ts` -- Zod shapes, titles, descriptions and annotations for the 11 tools; `guard()` turns a thrown `PlainAnswer` into plain text and anything else into an `isError` result. `RESERVED_TOOL_NAMES` (ADT MCP + PyPI ansible-mcp names we must never take).
- `src/handlers.ts` -- The tool bodies (orchestration: project prep, spawns, renderers).
- `src/exec.ts` -- `AnsibleRunner`: native or prefixed spawning (`buildPrefixedArgv`: `--cd` spliced before `--exec`, then `env -u X K=V <bin> args`), prefix parsing/validation, wsl.exe UTF-16 error decoding, missing-binary messages, Ansible-side env/HOME/cache root, the dummy vault file, Ansible-side file ops (fs natively, `cat`/`mkdir`/`tee`/`mv`/`rm` through a prefix), `safetyEnv()`.
- `src/context.ts` -- `AnsibleContext`: per-dir `Project` (Ansible-side path, the DrvFs `ANSIBLE_CONFIG` rule), `runSafe()`, the config dump cache (per dir + ansible.cfg mtime), `ansible --version` once per process, the installed-content fingerprint (30 s), the ansible-doc cache and batching with the tombstone retry, `-l -j` listings.
- `src/paths.ts` -- `PlainAnswer`, UNC rules (`\\wsl.localhost\<distro>` allowed only for the prefix's `-d`), Windows <-> WSL translation. Pure.
- `src/yaml.ts` -- The YAML 1.1 reader (eemeli `yaml`, PyYAML-compatible booleans, `!vault` / `!unsafe`, line numbers, duplicate keys). Pure.
- `src/project.ts` -- Static reading: task extraction (action vs keyword, `action:`/`local_action:`, free-form `parse_kv`, `args:` merge, include targets, FQCN plugin refs in Jinja), the playbook/role walk (role deps first, literal include/import followed, templated ones listed), project detection, static ansible.cfg read.
- `src/ansibleDoc.ts` -- ansible-doc JSON parsing, stderr classification (missing / redirect deprecation / tombstone), option lookup by alias, module-doc rendering.
- `src/checkArgs.ts` -- `ansible_check_task_args` checks and rendering; `typeError()` mirrors Ansible's conversions; `resolveTaskDoc()` (collections keyword first) is shared with the walk users.
- `src/role.ts`, `src/inventory.ts`, `src/playbook.ts` (list/stderr parsing, the R1 lookup pre-scan, local plugin listing), `src/config.ts` (dump parsing, galaxy credential redaction, the safety footer), `src/collections.ts`, `src/constraints.ts` (galaxy constraint evaluator), `src/lint.ts`, `src/redact.ts` -- pure renderers/parsers.
- `src/upgrade.ts` -- `ansible_upgrade_impact`: runtime.yml parsing and routing, the per-task diff rules, the report and verdict, requirements constraint lines, galaxy error mapping, `ensureTarget()` (cache hit by MANIFEST.json version, else `install --no-deps -p <.tmp-*>` then rename), orchestration, `include_unused` via `--metadata-dump`.
- `bin/ansible-mcp.mjs` -- npm `bin`, the oam-discovering runtime launcher (see Runtime below). Prefers the newest oam at or above `OAM_MIN` (0.19.0), else imports `dist/index.js` into its own process.
- `scripts/runtime.mjs` (oam discovery for the dev scripts), `scripts/typecheck.mjs` (`oam check .`, else tsc), `scripts/check-oam-floor.mjs` (floor drift + staleness), `scripts/check-compliance.mjs` (mcp-compliance grade A gate), `scripts/lint.mjs` (Biome).

## Key patterns

- **Never execute plays, never `--check`, never contact a managed host.** The allowed commands are listed in design.md 4.1 and in the README. `--check` stays out even for `connection=local`: check mode is not read-only (`check_mode: false` tasks, modules without check support, lookups). Never pass `--fix`, `--write`, `--force`, `--become`, `-r requirements.yml` or `--upgrade`.
- **Every Ansible child except `ansible-config dump` gets `safetyEnv()`** (via `ctx.runSafe`): `ANSIBLE_VAULT_PASSWORD_FILE` and `ANSIBLE_VAULT_IDENTITY_LIST` point at a server-owned file with a random password (empty or `/dev/null` both make Ansible fail, F7; a configured script would otherwise run), `ANSIBLE_INVENTORY_ENABLED=host_list,yaml,ini,toml` (script/constructed/auto execute code on `--list` AND `--graph`, F8), `ANSIBLE_VARS_ENABLED=host_group_vars`, local temp and galaxy cache in the server's cache, `ask_*` off, colours off, `ANSIBLE_VAULT_ID_MATCH` unset. `ansible-config dump` gets only the colour vars so it reports the user's real settings; tools add a `safety: ...` footer when the user's config had something we replaced.
- **Nothing is written into an existing `~/.ansible`.** The commands that skip the safety env (`ansible-config dump`, `--version` probes) still get `ANSIBLE_LOCAL_TEMP` in the server's cache (`ctx.quietEnv()`; resolving the config creates a dir under local_tmp), and the injected `DEFAULT_LOCAL_TMP` row is hidden from `ansible_config`. The galaxy install gets `ANSIBLE_GALAXY_TOKEN_PATH` in the cache when the user has no token file. Accepted residue (design.md R4): an empty `~/.ansible` when missing, and ansible-lint's empty `~/.ansible/roles` / `collections`. The dummy vault file is one `vault-null` per cache, reused.
- **R1 pre-scan before any `ansible-playbook` / `ansible-lint` run on a playbook:** lookups in play-level `name`, `hosts`, `vars_files` or `import_playbook` refuse with plain text unless `ANSIBLE_MCP_ALLOW_PLAY_LOOKUPS=1`. The residue (play-level Jinja without a literal lookup, playbook-adjacent `vars_plugins/`) is documented, listed in output, and pinned by the hostile-project integration test.
- **No shell anywhere; args are arrays.** User values only ever follow a fixed flag as separate argv elements; values starting with `-` are refused for `limit`, `tags`, `skip_tags`, `host`, `group`, `name`, `role`, paths. With a WSL prefix, `--exec` is mandatory (`--` makes WSL run bash, F20); env crosses only as `env K=V` (F21); `ANSIBLE_MCP_PASS_ENV` forwards named server vars.
- **Paths:** `dir` resolves server-side; UNC/device paths are refused before any fs call (NTLM), except `\\wsl.localhost\<distro>\...` / `\\wsl$\...` for the prefix's own `-d`. Windows paths translate with the mount root from `wslpath -a -u C:\` (learned once). Ansible-printed paths display relative to `dir`, else `X:\...`, else `<linux path> (inside WSL)`. DrvFs rule (F22): in WSL style, when `<dir>/ansible.cfg` exists on a Windows drive, `ANSIBLE_CONFIG` is set to it explicitly, because Ansible ignores a cfg in a world-writable dir.
- **YAML is read as YAML 1.1 with PyYAML's booleans** (`yes/no/on/off/true/false`, not `y/n`), octal `0755`, `!vault` as `{__ansible_vault}`. Reports name YAML 1.1 traps (`choice false comes from unquoted 'off'`, `mode 0755 is the octal integer 493`).
- **ansible-doc results are keyed by the name asked; `doc.plugin_name` is the FQCN.** Missing = exit 0 + `{}` + "was not found"; tombstone = exit 1, and one tombstone fails the whole batch, so `ctx.docs()` records it and re-runs without it. Batches of 50. Cached in memory per fingerprint (target-path lookups are not cached).
- **`ansible_check_task_args` never says "valid"**: cross-option rules (mutually_exclusive, required_if, ...) and argument_spec-only deprecations are not in ansible-doc output (F3); the footer says so. Prose hints of mutual exclusion in option descriptions (`instead of O(src)`) are surfaced as `[not checked: ...]`. Task values are never echoed, except the offending value of a choice/type error, which is skipped for `no_log`, secret-like names and secret-shaped values.
- **Redaction** (`redact.ts`, design.md 5): layer 1 Ansible markers (`__ansible_vault`, `$ANSIBLE_VAULT;`, `__ansible_unsafe` unwrapped), layer 3 secret-like names (terraform-cwd-mcp's tokenizer + `vault_<name>`, with `addr`/`address` as metadata), layer 4 value shapes (+ URL userinfo and inline credentials masked in place), then layer 2 (strings equal to / containing a hidden one). A single plain Jinja reference prints as `"{{ x }}" (template, not rendered)`. Galaxy `token`/`password`/`client_secret` always redacted. Tests assert no `FIXTURE-SECRET` / `FIXTURE-plain` sentinel in any output.
- **Whole-file vaults degrade, they do not fail** (`ansible_inventory`): on a decrypt error, re-run with `ANSIBLE_VARS_ENABLED=none` for inventory-file vars, then list each group_vars/host_vars file with redacted values and the vault files as `<vaulted file, not read>`.
- **`ansible_upgrade_impact` touches only its cache.** Target dir `<cache>/collections/<ns.name>/<version>/` (a hit = MANIFEST.json says that version; offline reruns work). A miss installs into `.tmp-<version>-<rand>` beside it with `--no-deps`, verifies MANIFEST.json and renames (`mv -T` through a prefix); temp dirs are removed in `finally` behind a guard that the path is a `.tmp-*` under the cache root. Target docs come from `ansible-doc` with `ANSIBLE_COLLECTIONS_PATH=<target>:<COLLECTIONS_PATHS>` (F25); a doc whose `filename` is not under the target means the target lacks it. Calls are serialized in-process. `openWorldHint: true` only here.
- **No caching** of inventory, config-dependent reports, playbook structure, lint or collections reports beyond the per-mtime config dump: they describe mutable files.
- **Every string parameter has `maxLength`** (paths 4096, names 256, versions 64, patterns 512, inline YAML 100 000), every number min/max, every array maxItems; `check:compliance` must grade A.
- **Tool names carry the `ansible_` prefix and never reuse ADT MCP / PyPI names** (`ansible_lint`, `ansible_navigator`, `lint`, `playbook_run`, ...): `exec.test.ts` checks the listing against `RESERVED_TOOL_NAMES`. That is why lint is `ansible_lint_summary`. Renaming after 0.1.0 is a breaking change.
- **npm only: no SEA binary** (no build-binary.mjs, no sea-config.json, no release assets).

## Runtime: oam or Node

[oam](https://oamjs.org) is not an npm dependency and is never assumed present. Ported from terraform-cwd-mcp (caddy-mcp's launcher minus the sandbox, ssh-mcp's no-sandbox shape).

| Task | Default | Alternate |
|---|---|---|
| `bin` entry (`bin/ansible-mcp.mjs`) | newest oam at or above 0.19.0, else Node in-process | `ANSIBLE_MCP_RUNTIME=node` / `=oam`, `OAM_BIN`; see the launcher header |
| `npm run typecheck` | `oam check .` if available, else `tsc --noEmit` | `ANSIBLE_MCP_RUNTIME=node` forces tsc; `typecheck:tsc` pins it |
| `npm test`, `npm start` | Node | -- |

- **Launcher discovery:** `OAM_BIN`, then `OAM_INSTALL_DIR`, `%LOCALAPPDATA%\oam\bin` (Windows), `~/.oam/bin`, then `PATH` (`.exe` only on Windows; a `.cmd`/`.bat` shim is named, never run). Every candidate must print oam's own banner; the newest at or above the floor wins.
- **Already on oam:** launched as `oam run bin/ansible-mcp.mjs` on an oam at the floor, it serves in-process. A host oam below the floor hands off (piped stdio) to a newer oam or to Node, or exits 1.
- **No `--permission` sandbox:** tools spawn Ansible, read caller-named dirs and write caches.
- **Why the floor matters here:** spawns pass an explicit `env` that deletes `ANSIBLE_VAULT_ID_MATCH` and replaces the user's vault password settings; oam up to 0.17.x laid an explicit env over its own, resurrecting deleted variables.
- **Floor policy:** one verified oam release at a time, the latest. `npm run check:oam-floor` fails on any floor claim in the launcher, README.md, CLAUDE.md or `src/tests/launcher.test.ts` that disagrees with `OAM_MIN` (offline half also runs in `oam-floor.test.ts`), and on a floor behind the latest oam release (online half, release.sh; `ANSIBLE_MCP_ALLOW_STALE_OAM=1` overrides). Bumping: change `OAM_MIN`, re-verify (MCP handshake plus ansible_role_interface and ansible_upgrade_impact under the new oam), fix every claim the checker names.

## Environment variables

All optional. The server's own are read in `src/exec.ts` / `src/context.ts`; the runtime ones in the launcher and scripts.

| Var | Default | Purpose |
|---|---|---|
| `ANSIBLE_MCP_DIR` | `process.cwd()` | Project when a call passes no `dir`. |
| `ANSIBLE_MCP_COMMAND_PREFIX` | unset (native) | JSON array (or whitespace string) prepended to every Ansible command. WSL style requires `--exec`/`-e`. |
| `ANSIBLE_MCP_BIN_DIR` | unset (`PATH`) | Ansible-side dir of the `ansible-*` executables; also prepended to the child's PATH. |
| `ANSIBLE_MCP_PATH_STYLE` | `auto` | `wsl` / `native`; auto = wsl when the prefix starts with wsl(.exe). |
| `ANSIBLE_MCP_PASS_ENV` | unset | Comma-separated server env names forwarded to the Ansible side in prefix mode. |
| `ANSIBLE_MCP_TIMEOUT_MS` | `120000` | Kill timeout per Ansible command (upgrade download 3x). Below 1 -> default; above 2^31-1 clamped. |
| `ANSIBLE_MCP_CACHE` | `~/.cache/ansible-mcp` | Server-side cache; also the Ansible-side cache in native mode. |
| `ANSIBLE_MCP_REMOTE_CACHE` | `$HOME/.cache/ansible-mcp` (Ansible side) | Ansible-side cache in prefix mode (vault-null file, local temp, galaxy cache, upgrade targets). |
| `ANSIBLE_MCP_ALLOW_DYNAMIC_INVENTORY` | unset | `1` re-enables script/constructed/plugin inventory sources. |
| `ANSIBLE_MCP_ALLOW_PLAY_LOOKUPS` | unset | `1` disables the R1 pre-scan refusal. |
| `ANSIBLE_MCP_RUNTIME` | `auto` | Read by `bin/ansible-mcp.mjs` and `scripts/runtime.mjs`: `auto`, `oam` or `node`. |
| `OAM_BIN` / `OAM_INSTALL_DIR` | unset | oam discovery inputs for the launcher. |
| `ANSIBLE_MCP_ALLOW_STALE_OAM` | unset | `1` lets `check-oam-floor.mjs` pass with a floor behind the latest oam release. |

## Tests

- Fixtures (`src/tests/fixtures/`, see its README): `project/` (vault-encrypted vars, a role with argument_specs, playbooks, requirements, `bad_args.yml`), `hostile/` (every hook touches a marker file), and `output/`: real captures from ansible-core 2.21.5 / ansible-lint 26.10.1 with `MANIFEST.tsv` naming each command and exit code. Captured paths are `/tmp/ansible-mcp-work/project`; `retarget()` rewrites them for replay.
- `checkArgs.test.ts` -- the design.md 7.4 output on `bad_args.yml` line for line, YAML 1.1 cases, aliases, conflicting actions, `action:`/`local_action:`, blocks, duplicates, parse_kv, the keyword list vs `doc/keywords.json`, type conversions.
- `upgrade.test.ts` -- the walk (roles, deps, short names), the exact design.md 6.6 findings for community.general 9.5.2 -> 12.0.0 and ansible.posix 1.5.4 -> 2.0.0 from the real docs and runtime files, the report/verdict, unit-only rules (alias dropped, removal without routing, resolved redirect, non-convertible type, BLOCKED), galaxy error mapping, constraint lines.
- `parsers.test.ts` -- ansible-doc parsing and stderr classes, inventory graph/host/fallback (no sentinel even in the decrypted capture), list-tasks/stderr parsing, the R1 pre-scan on `hostile/play.yml`, config + galaxy credential redaction, collections (design.md 7.9 output, shadowing order), lint grouping, role rendering (ansible-doc and file give identical output), the YAML reader, detection, `ansible --version`.
- `redact.test.ts`, `exec.test.ts` -- redaction layers; prefix parsing/validation, argv construction, UTF-16 decoding, a prefixed run through a fake spawner, path translation, UNC rules, the safety env, and the reserved-name check over the real tool listing.
- `server.test.ts` -- real McpServer + Client over InMemoryTransport with a replaying `Spawner`: the listing (titles, annotations, maxLength/min/max/maxItems, instructions naming every tool and the authority split), every tool end to end on the fixture project with no sentinel in any output and the safety env on every child but `ansible-config`, the R1 refusal without spawning, upgrade download-once-then-cache, native-Windows plain answers, parameter validation.
- `integration.test.ts` -- real Ansible: natively, or on Windows through `ANSIBLE_MCP_TEST_PREFIX` (default `["wsl.exe","-d","Ubuntu","--exec"]`) + `ANSIBLE_MCP_TEST_BIN_DIR` (default `/tmp/ansible-mcp-venv/bin`), with the installed set from `ANSIBLE_MCP_TEST_COLLECTIONS_PATH` (default `/tmp/ansible-mcp-work/collections`). Skips cleanly when Ansible is unreachable. Copies the fixtures to an Ansible-side work dir (reached from Windows via `\\wsl.localhost`), sets `ANSIBLE_HOME`/local temp/`XDG_CACHE_HOME` there and removes it afterwards. Covers every tool on `project/` (dir snapshot unchanged), the hostile markers (none; with `ALLOW_PLAY_LOOKUPS=1` exactly the R1 residue), the DrvFs `ANSIBLE_CONFIG` rule (Windows), ansible.posix 1.5.4 -> 2.0.0 download + offline rerun via a dead `HTTPS_PROXY` + galaxy errors, and WSL plumbing (14-argument round-trip, kill on timeout, bad distro, missing binary). `ANSIBLE_MCP_TEST_BIG=1` adds community.general 9.5.2 -> 12.0.0. The WSL venv in `/tmp` disappears when the distro stops; recreate it per the fixtures README.
- `launcher.test.ts`, `oam-floor.test.ts` -- ported from terraform-cwd-mcp; the stdio smoke calls `ansible_role_interface` (no Ansible needed). POSIX-only fake-oam cases skip on Windows.

## Commands

```bash
npm run build      # tsup + tsc declarations
npm run dev        # Watch mode
npm test           # vitest
npm run lint       # Biome check (via scripts/lint.mjs)
npm run lint:fix   # Biome auto-fix
npm run typecheck  # oam check . if oam is installed, else tsc --noEmit (typecheck:tsc pins tsc)
npm run test:ci    # Build + test
npm run check:compliance  # @yawlabs/mcp-compliance, must grade A (after build; release.sh runs it)
npm run check:oam-floor   # oam floor drift + staleness (release.sh runs it)
```

Release: `bash release.sh X.Y.Z` (no CI workflows in this repo).

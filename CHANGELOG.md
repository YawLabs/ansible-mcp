# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] -- 2026-10-30

### Changed
- oam floor raised to 0.19.1 (`OAM_MIN` in `bin/ansible-mcp.mjs`), the latest
  oam release. oam 0.19.0 and older, 0.19.0 dev builds included, are now below
  the floor: the launcher passes them over, and a host on one hands off.
  Re-verified through the launcher on oam 0.19.1: MCP handshake, tools/list,
  `ansible_role_interface` and `ansible_upgrade_impact`'s argument checks.

### Security
- The `--version` probes (`ansible`, `ansible-lint`, and the per-binary probes
  of `ansible_project_info`) now run under the full safety environment, so
  every Ansible child except `ansible-config dump` gets it, as documented.
  Verified with real ansible-core 2.21.5: no tool runs a `vault_password_file`
  script from the effective ansible.cfg (new integration test forces the
  hostile project's ansible.cfg on every child).

### Fixed
- `scripts/check-oam-floor.mjs` no longer exits 0 in silence when run from a
  junctioned or symlinked checkout: its is-this-the-main-module test now
  realpaths both `process.argv[1]` and the module's own path, as Node does for
  the latter.
- `ansible_check_task_args`: a string `mode` (any key=value `mode=`, or a
  quoted one) that is neither octal nor symbolic (`mode=493`, `0x1ed`) is
  reported; Ansible fails such a task. Key=value values are strings, so
  `mode=755` / `mode=0755` are both 0755 and get no YAML 1.1 hint (checked
  against real Ansible).
- `ansible_collections` / `ansible_upgrade_impact`: shadowing order and the
  site-packages bundle line no longer assume `/`-separated paths. Native
  Windows separators, `\\wsl.localhost` UNC paths, drive paths vs their WSL
  translation, and a COLLECTIONS_PATHS entry ending in `ansible_collections`
  all match; Debian's `dist-packages` bundle is recognised too.
- `ansible_upgrade_impact`: a tarball download that breaks after Galaxy
  answered (`Failed to download collection tar ... <urlopen error ...>`, seen
  as a connection reset in a real run) is a plain "could not reach Galaxy
  server" answer with the cached targets, not a raw ansible-galaxy dump.

## [0.1.2] -- 2026-10-16

### Fixed
- `ansible_check_task_args`: the dict form `action: {module: "command ..."}`
  splits the module string as Ansible does -- the first word is the module,
  the rest is `k=v` (check_raw for the free-form command modules), and those
  args win over the dict's other keys. Before, the whole string was taken as
  the module name and its args were dropped.

## [0.1.1] -- 2026-10-16

### Security
- R1 lookup pre-scan: YAML aliases (values and keys) are resolved, with an
  expansion limit; any `lookup`/`query`/`pipe` mention and a bare `q` inside
  Jinja are flagged; playbooks outside `dir` are scanned at their real path;
  lint folder targets and the no-paths case are walked at any depth (only
  ansible-lint's own excludes skipped); unreadable targets are refused;
  `ansible.legacy.import_playbook` is followed.
- Option injection: dash-leading task keys and role names never reach
  ansible-doc, and dash-leading paths are refused after normalization (a
  `./--fix` lint target no longer becomes `--fix`).
- Redaction: argument_spec and upgrade-report defaults are redacted; learned
  secrets are hidden after in-place URL / inline-credential masking;
  password-only URLs (`redis://:pw@h`) are masked; YAML 1.1 hints no longer
  echo secret values; the inventory fallback learns inventory vars first.

### Fixed
- `ansible_check_task_args`: free-form modules keep non-option `k=v` in the
  command (Ansible's check_raw); the action's own args win over `args:`; list
  options with choices but no `elements` are checked per item.
- `ansible_module_doc`: a deprecated, missing name answers the same on repeat
  calls (the doc cache keeps deprecations).
- The Ansible-side cache never falls back to `/tmp`, and a failed `env` probe
  is not cached; the temp-dir removal guard rejects `..`.
- `ansible_upgrade_impact`: an unevaluable `requires_ansible` says "could not
  evaluate"; a corrupt cached target is moved aside instead of failing every
  call; the cached manifest version is checked; galaxy errors are redacted.
- `release.sh`: refuses a dirty tree, a main behind origin, a missing `jq`,
  and an existing tag that is not HEAD; oam probes have timeouts.

## [0.1.0] -- 2026-10-15

### Added
- Initial release: a read-only MCP server for what is true in THIS Ansible
  checkout on THIS control node. It never runs a play, never runs `--check`,
  never connects to a managed host and never supplies a vault secret.
- `ansible_project_info`: ansible-core version, effective config file,
  collections and roles paths, installed `ansible-*` binaries, detected
  playbooks, inventories, roles and requirements files.
- `ansible_module_doc` and `ansible_module_search`: exact option specs of the
  installed modules and plugins (ansible-doc), with redirects and tombstones
  resolved and the providing collection version.
- `ansible_check_task_args`: tasks (inline YAML or a file) against the installed
  docs -- unknown options, missing required ones, choices, types, suboptions,
  YAML 1.1 traps (`off`, `0755`), deprecated options, duplicate keys -- and
  what ansible-doc cannot check.
- `ansible_role_interface`: argument specs, redacted defaults, undocumented
  defaults, dependencies, vars names and galaxy_info for local and collection
  roles.
- `ansible_inventory`: groups, hosts and inventory-level vars, always redacted;
  whole-file vaults degrade to a per-file view; dynamic inventory off unless
  `ANSIBLE_MCP_ALLOW_DYNAMIC_INVENTORY=1`.
- `ansible_playbook_structure`: syntax check, plays, matched hosts, tasks with
  module and file:line, tags and parse-time deprecation warnings, behind a
  pre-scan that refuses play-level lookups unless
  `ANSIBLE_MCP_ALLOW_PLAY_LOOKUPS=1`.
- `ansible_config`: effective config with origins; galaxy credentials always
  redacted.
- `ansible_collections`: requirements.yml vs installed collections and roles,
  with galaxy constraint semantics and shadowing across collections paths.
- `ansible_lint_summary`: `ansible-lint --offline` grouped by rule. Never fixes.
- `ansible_upgrade_impact`: what breaks in this project's tasks if a collection
  moves to an exact version (removed or moved modules, removed options and
  aliases, newly required options, dropped choices, type and default changes,
  requirements constraints, `requires_ansible`), tied to file:line. Downloads
  only the target into the server's cache (`--no-deps`), reuses it offline.
- Windows support through a command prefix (`ANSIBLE_MCP_COMMAND_PREFIX`, e.g.
  `["wsl.exe","-d","Ubuntu","--exec"]`) with path translation, env forwarding
  (`ANSIBLE_MCP_PASS_ENV`) and the DrvFs `ANSIBLE_CONFIG` rule.
- oam-discovering launcher (`bin/ansible-mcp.mjs`), oam 0.19.0 floor.

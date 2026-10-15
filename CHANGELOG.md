# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

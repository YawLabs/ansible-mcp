import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AnsibleContext } from "./context.js";
import {
  checkTaskArgs,
  collections,
  config,
  inventory,
  lintSummary,
  moduleDoc,
  moduleSearch,
  playbookStructure,
  projectInfo,
  roleInterface,
} from "./handlers.js";
import { PlainAnswer } from "./paths.js";
import { upgradeImpact } from "./upgrade.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const error = (t: string): ToolResult => ({ isError: true, content: [{ type: "text", text: `Error: ${t}` }] });

/** Run a tool body: a PlainAnswer is a fact (plain text), any other throw is an MCP error result. */
async function guard(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return text(await fn());
  } catch (e) {
    if (e instanceof PlainAnswer) return text(e.message);
    return error(e instanceof Error ? e.message : String(e));
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Read-only for the user's files, but downloads from Galaxy on a cache miss. */
const READ_ONLY_OPEN = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const PATH_MAX = 4096;

const dirParam = z
  .string()
  .max(PATH_MAX)
  .optional()
  .describe("Ansible project directory. Default: ANSIBLE_MCP_DIR, else the server's working directory.");

const descParam = z
  .number()
  .int()
  .min(0)
  .max(2000)
  .optional()
  .default(160)
  .describe("Truncate each description to this many characters; 0 = no limit (default 160)");

const R1 =
  " Parses playbooks with Ansible: treat dir as code you would run --syntax-check on (play-level Jinja and playbook-adjacent vars plugins are evaluated); lookups in play-level fields are refused unless ANSIBLE_MCP_ALLOW_PLAY_LOOKUPS=1.";

/** The names this server must never take (ADT MCP and the PyPI ansible-mcp ship them; design.md section 0). */
export const RESERVED_TOOL_NAMES = [
  "zen_of_ansible",
  "ansible_content_best_practices",
  "list_available_tools",
  "ansible_lint",
  "ade_environment_info",
  "ade_setup_environment",
  "adt_check_env",
  "create_ansible_projects",
  "ansible_create_playbook",
  "ansible_create_collection",
  "define_and_build_execution_env",
  "ansible_navigator",
  "lint",
  "playbook_syntax_check",
  "playbook_run",
  "inventory_parse",
  "inventory_graph",
];

export function registerTools(server: McpServer, ctx: AnsibleContext): void {
  server.registerTool(
    "ansible_project_info",
    {
      title: "Ansible project overview",
      description:
        "What this Ansible checkout contains and how Ansible sees it: ansible-core version, effective config file, collections and roles paths, installed ansible-* binaries, detected playbooks, inventories, roles and requirements files. " +
        "Call it first. Read-only; never connects to a managed host (AAP MCP covers controller state, ADT MCP takes actions).",
      inputSchema: { dir: dirParam },
      annotations: READ_ONLY,
    },
    async ({ dir }) => guard(() => projectInfo(ctx, dir)),
  );

  server.registerTool(
    "ansible_module_doc",
    {
      title: "Installed module/plugin spec",
      description:
        "Exact options (type, required, default, choices, aliases, suboptions) of a module or plugin as INSTALLED here (ansible-doc), with the collection version that provides it and redirects resolved. " +
        "Use before writing a task; options drift between collection versions, so training-data guesses are often wrong.",
      inputSchema: {
        name: z.string().max(256).describe("FQCN or short name, e.g. community.general.ufw or ufw"),
        type: z
          .string()
          .max(32)
          .optional()
          .default("module")
          .describe(
            "module | lookup | filter | test | callback | connection | inventory | become | cache | vars | strategy | shell | cliconf | httpapi | netconf | keyword",
          ),
        dir: dirParam,
        include_return: z.boolean().optional().default(true).describe("List documented return values (modules)"),
        include_examples: z.boolean().optional().default(false).describe("Append the EXAMPLES block"),
        description_chars: descParam,
      },
      annotations: READ_ONLY,
    },
    async ({ name, type, dir, include_return, include_examples, description_chars }) =>
      guard(() =>
        moduleDoc(ctx, {
          name,
          type,
          dir,
          includeReturn: include_return,
          includeExamples: include_examples,
          descriptionChars: description_chars,
        }),
      ),
  );

  server.registerTool(
    "ansible_module_search",
    {
      title: "Search installed plugins",
      description:
        "Find installed modules or plugins by name or description (ansible-doc -l), ranked exact name, prefix, token, then description match. " +
        "Pass query, collection, or both.",
      inputSchema: {
        query: z.string().max(256).optional().describe("Case-insensitive name or description text, e.g. 'firewall'"),
        collection: z.string().max(256).optional().describe("Limit to one collection, e.g. ansible.posix"),
        type: z.string().max(32).optional().default("module").describe("Plugin type (default module)"),
        dir: dirParam,
        limit: z.number().int().min(1).max(500).optional().default(50).describe("Max results (default 50)"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, collection, type, dir, limit }) =>
      guard(() => moduleSearch(ctx, { query, collection, type, dir, limit })),
  );

  server.registerTool(
    "ansible_check_task_args",
    {
      title: "Check task arguments",
      description:
        "Check tasks (inline YAML, or a tasks file / playbook) against the INSTALLED module docs: unknown options, missing required ones, bad choices and types (YAML 1.1 aware: unquoted off/yes/0755), suboptions, deprecated options. " +
        "ansible-doc cannot express cross-option rules (mutually_exclusive, required_if), so the answer says what it could not check; it catches action-plugin modules (copy, template) that ansible-lint's args rule skips.",
      inputSchema: {
        task: z.string().max(100_000).optional().describe("YAML: one task mapping, or a list of tasks"),
        file: z.string().max(PATH_MAX).optional().describe("Tasks file, role tasks file or playbook, relative to dir"),
        line: z.number().int().min(1).max(1_000_000).optional().describe("Only the task whose span contains this line"),
        dir: dirParam,
      },
      annotations: READ_ONLY,
    },
    async ({ task, file, line, dir }) => guard(() => checkTaskArgs(ctx, { task, file, line, dir })),
  );

  server.registerTool(
    "ansible_role_interface",
    {
      title: "Role interface",
      description:
        "A role's interface: argument_specs entry points and options (no_log honoured), defaults with redacted values, which defaults are undocumented, dependencies, vars names and galaxy_info. " +
        "Works for local roles (roles_path, dir/roles, or a path) and collection roles (ns.collection.role).",
      inputSchema: {
        role: z.string().max(256).describe("Local role name, path relative to dir, or ns.collection.role"),
        dir: dirParam,
        entry_point: z.string().max(128).optional().describe("Only this entry point (default: all)"),
        description_chars: descParam,
      },
      annotations: READ_ONLY,
    },
    async ({ role, dir, entry_point, description_chars }) =>
      guard(() => roleInterface(ctx, { role, dir, entryPoint: entry_point, descriptionChars: description_chars })),
  );

  server.registerTool(
    "ansible_inventory",
    {
      title: "Inventory structure and vars",
      description:
        "Groups, hosts and inventory-level vars (ansible-inventory --graph/--list/--host), always redacted: vault values, secret-like names and secret-shaped values are hidden, templates are shown unrendered. " +
        "Script and plugin inventory sources run code, so they are skipped unless ANSIBLE_MCP_ALLOW_DYNAMIC_INVENTORY=1 (which can also call cloud APIs); vault secrets are never supplied, so whole-file vaults degrade to a per-file view.",
      inputSchema: {
        dir: dirParam,
        inventory: z
          .string()
          .max(PATH_MAX)
          .optional()
          .describe("Inventory source relative to dir (default: ansible.cfg's)"),
        host: z.string().max(255).optional().describe("Show one host's vars (--host)"),
        group: z.string().max(255).optional().describe("Root the graph at this group"),
        vars: z
          .string()
          .max(16)
          .optional()
          .describe("none | names | values (default: names for the list, values for host)"),
        limit: z.number().int().min(1).max(5000).optional().default(200).describe("Max hosts listed (default 200)"),
      },
      annotations: READ_ONLY,
    },
    async ({ dir, inventory: inv, host, group, vars, limit }) =>
      guard(() => inventory(ctx, { dir, inventory: inv, host, group, vars, limit })),
  );

  server.registerTool(
    "ansible_playbook_structure",
    {
      title: "Playbook structure",
      description: `Plays, matched hosts, tasks (with module and file:line where unambiguous) and tags of a playbook (ansible-playbook --syntax-check, then --list-hosts --list-tasks --list-tags), plus deprecation warnings Ansible printed while parsing; never runs a play.${R1}`,
      inputSchema: {
        playbook: z.string().max(PATH_MAX).describe("Playbook path relative to dir"),
        dir: dirParam,
        inventory: z.string().max(PATH_MAX).optional().describe("Inventory source relative to dir"),
        limit: z.string().max(512).optional().describe("Host pattern (--limit)"),
        tags: z.string().max(512).optional().describe("Only these tags (--tags)"),
        skip_tags: z.string().max(512).optional().describe("Skip these tags (--skip-tags)"),
        max_tasks: z.number().int().min(1).max(5000).optional().default(300).describe("Max tasks listed (default 300)"),
      },
      annotations: READ_ONLY,
    },
    async ({ playbook, dir, inventory: inv, limit, tags, skip_tags, max_tasks }) =>
      guard(() =>
        playbookStructure(ctx, {
          playbook,
          dir,
          inventory: inv,
          limit,
          tags,
          skipTags: skip_tags,
          maxTasks: max_tasks,
        }),
      ),
  );

  server.registerTool(
    "ansible_config",
    {
      title: "Effective Ansible config",
      description:
        "The effective configuration for this dir (ansible-config dump) with each setting's origin (ansible.cfg, env, default); galaxy server tokens and passwords are always redacted. " +
        "Settings this server overrides for safety in its other tools (vault password files, inventory and vars plugins) are flagged.",
      inputSchema: {
        dir: dirParam,
        all: z.boolean().optional().default(false).describe("Every setting, not only those changed from the defaults"),
        filter: z.string().max(256).optional().describe("Case-insensitive substring of the setting name"),
        limit: z.number().int().min(1).max(2000).optional().default(300).describe("Max settings listed (default 300)"),
      },
      annotations: READ_ONLY,
    },
    async ({ dir, all, filter, limit }) => guard(() => config(ctx, { dir, all, filter, limit })),
  );

  server.registerTool(
    "ansible_collections",
    {
      title: "Collections vs requirements",
      description:
        "requirements.yml (collections and roles) against what is installed: ok, VIOLATES (with file:line) or MISSING, using galaxy constraint rules, plus collections shadowed across collections paths (the first in COLLECTIONS_PATHS wins). " +
        "Never installs anything.",
      inputSchema: {
        dir: dirParam,
        requirements: z
          .string()
          .max(PATH_MAX)
          .optional()
          .describe(
            "Requirements file relative to dir (default: requirements.yml, collections/requirements.yml, roles/requirements.yml)",
          ),
        include_extras: z.boolean().optional().default(false).describe("List installed collections nothing requires"),
      },
      annotations: READ_ONLY,
    },
    async ({ dir, requirements, include_extras }) =>
      guard(() => collections(ctx, { dir, requirements, includeExtras: include_extras })),
  );

  server.registerTool(
    "ansible_lint_summary",
    {
      title: "ansible-lint summary",
      description: `ansible-lint (offline) grouped by rule with counts, severities and file:line locations; never fixes anything (ADT MCP's ansible_lint fixes).${R1}`,
      inputSchema: {
        dir: dirParam,
        paths: z
          .array(z.string().max(PATH_MAX))
          .max(50)
          .optional()
          .describe("Paths relative to dir (default: lint's own discovery)"),
        profile: z.string().max(32).optional().describe("min | basic | moderate | safety | shared | production"),
        max_locations: z
          .number()
          .int()
          .min(0)
          .max(500)
          .optional()
          .default(5)
          .describe("Locations listed per rule (default 5)"),
      },
      annotations: READ_ONLY,
    },
    async ({ dir, paths, profile, max_locations }) =>
      guard(() => lintSummary(ctx, { dir, paths, profile, maxLocations: max_locations })),
  );

  server.registerTool(
    "ansible_upgrade_impact",
    {
      title: "Collection upgrade impact",
      description:
        "What breaks in THIS project's tasks if one collection moves to an exact version: removed or moved modules (meta/runtime.yml redirects and tombstones), removed options and aliases, newly required options, dropped choices, type and default changes, each tied to the task's file:line, plus requirements.yml constraints and a verdict. " +
        "Downloads the target collection from Galaxy (or the configured servers) into this server's cache on first use; never touches dir, requirements files or your collections paths.",
      inputSchema: {
        collection: z.string().max(256).describe("namespace.name, e.g. community.general"),
        version: z.string().max(64).describe("Exact target version, e.g. 12.0.0 (not a constraint)"),
        dir: dirParam,
        playbooks: z
          .array(z.string().max(PATH_MAX))
          .max(50)
          .optional()
          .describe("Playbooks to walk (default: all detected)"),
        syntax_check: z
          .boolean()
          .optional()
          .default(true)
          .describe("Confirm with ansible-playbook --syntax-check against the target"),
        include_unused: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Also list removed/moved/deprecated content of the collection this project does not use (capped at 200)",
          ),
      },
      annotations: READ_ONLY_OPEN,
    },
    async ({ collection, version, dir, playbooks, syntax_check, include_unused }) =>
      guard(() =>
        upgradeImpact(ctx, {
          collection,
          version,
          dir,
          playbooks,
          syntaxCheck: syntax_check,
          includeUnused: include_unused,
        }),
      ),
  );
}

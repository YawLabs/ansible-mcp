import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AnsibleContext, type ContextOptions } from "./context.js";
import { defaultLocalCache } from "./exec.js";
import { registerTools } from "./tools.js";
import { sweepStaleTempDirs } from "./upgrade.js";

export * from "./ansibleDoc.js";
export * from "./checkArgs.js";
export * from "./collections.js";
export * from "./config.js";
export * from "./constraints.js";
export * from "./context.js";
export * from "./exec.js";
export * from "./inventory.js";
export * from "./lint.js";
export * from "./paths.js";
export * from "./playbook.js";
export * from "./project.js";
export * from "./redact.js";
export * from "./role.js";
export * from "./upgrade.js";
export * from "./yaml.js";

export const version: string = createRequire(import.meta.url)("../package.json").version;

export const INSTRUCTIONS =
  "What is actually true in THIS Ansible checkout on THIS control node, read-only; it never runs a play and never " +
  "connects to a managed host. Start with ansible_project_info. Before writing or editing a task, call " +
  "ansible_module_doc (exact options of the INSTALLED module version; find names with ansible_module_search) and then " +
  "ansible_check_task_args on the task or file: unknown options, missing required ones, bad choices and YAML 1.1 traps " +
  "(it says what ansible-doc cannot check). ansible_role_interface shows a role's argument specs, defaults (redacted) " +
  "and dependencies. ansible_inventory shows groups, hosts and inventory vars (always redacted; vault secrets are never " +
  "supplied; dynamic inventory is off by default). ansible_playbook_structure lists plays, hosts, tasks with file:line " +
  "and tags. ansible_config shows the effective config with origins. ansible_collections compares requirements.yml " +
  "with what is installed. ansible_lint_summary runs ansible-lint offline and groups the findings (it never fixes). " +
  "ansible_upgrade_impact shows what breaks in this project's tasks if a collection moves to an exact version (it " +
  "downloads the target into this server's cache, never into your collections paths). " +
  "Authority split: AAP MCP for controller jobs, templates and controller inventories; ADT MCP (ansible_lint with " +
  "fix, ansible_navigator, scaffolding, EE builds) for actions; this server for installed specs, task-argument " +
  "validity, role interfaces, local inventory, play structure, effective config, dependency drift and upgrade impact.";

export function createAnsibleMcpServer(opts: ContextOptions = {}): McpServer {
  const server = new McpServer({ name: "ansible-mcp", version }, { instructions: INSTRUCTIONS });
  registerTools(server, new AnsibleContext(opts));
  return server;
}

export async function startServer(): Promise<void> {
  // Leftover ansible_upgrade_impact temp dirs from a crashed run (older than 1 h), in the background.
  setImmediate(() => sweepStaleTempDirs(defaultLocalCache()));
  const server = createAnsibleMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

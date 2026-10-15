import {
  hasSecretShape,
  isSecretKey,
  maskInlineCredentials,
  maskUrlPasswords,
  REDACTED_NAME,
  REDACTED_SHAPE,
} from "./redact.js";

/**
 * `ansible-config dump --format json` (design.md F11): an array of
 * `{name, origin, value}` that ends with `{"GALAXY_SERVERS": {<server>: [{name,
 * origin, type, value}, ...]}}`. Galaxy server tokens and passwords come out in
 * clear text, so they are always redacted here. Pure.
 */

export interface ConfigSetting {
  name: string;
  origin: string;
  value: unknown;
}

export interface GalaxyField {
  name: string;
  origin: string;
  value: unknown;
}

export interface ConfigDump {
  settings: ConfigSetting[];
  galaxyServers: Record<string, GalaxyField[]>;
}

export function parseConfigDump(text: string): ConfigDump {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`ansible-config dump did not return JSON (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (!Array.isArray(data)) throw new Error("ansible-config dump returned JSON that is not an array.");
  const settings: ConfigSetting[] = [];
  let galaxyServers: Record<string, GalaxyField[]> = {};
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (Object.hasOwn(o, "GALAXY_SERVERS")) {
      galaxyServers = (o.GALAXY_SERVERS ?? {}) as Record<string, GalaxyField[]>;
      continue;
    }
    if (typeof o.name === "string") {
      settings.push({ name: o.name, origin: String(o.origin ?? ""), value: o.value });
    }
  }
  return { settings, galaxyServers };
}

export function setting(d: ConfigDump, name: string): ConfigSetting | undefined {
  return d.settings.find((s) => s.name === name);
}

/** A list-valued setting (COLLECTIONS_PATHS, DEFAULT_ROLES_PATH, DEFAULT_HOST_LIST). */
export function settingList(d: ConfigDump, name: string): string[] {
  const v = setting(d, name)?.value;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v) return v.split(/[:,]/).filter(Boolean);
  return [];
}

export function configFile(d: ConfigDump): string | null {
  const v = setting(d, "CONFIG_FILE")?.value;
  return typeof v === "string" && v ? v : null;
}

/** Settings the safety environment replaces in every other tool (design.md 4.2). */
export const OVERRIDDEN = new Set([
  "DEFAULT_VAULT_PASSWORD_FILE",
  "DEFAULT_VAULT_IDENTITY_LIST",
  "INVENTORY_ENABLED",
  "VARIABLE_PLUGINS_ENABLED",
]);

const changed = (s: ConfigSetting | undefined) => !!s && s.origin !== "default";

/**
 * The footer line naming what the safety environment replaced, or "" when the
 * user's effective config had nothing we override.
 */
export function safetyFooter(d: ConfigDump, allowDynamicInventory: boolean): string {
  const parts: string[] = [];
  const short = (o: string) => (o.startsWith("env: ") ? o : "ansible.cfg");
  const pw = setting(d, "DEFAULT_VAULT_PASSWORD_FILE");
  if (changed(pw) && pw!.value) {
    parts.push(`vault_password_file from ${short(pw!.origin)} ignored (ansible-mcp never supplies vault secrets)`);
  }
  const ids = setting(d, "DEFAULT_VAULT_IDENTITY_LIST");
  if (changed(ids) && Array.isArray(ids!.value) && ids!.value.length) {
    parts.push(`vault_identity_list from ${short(ids!.origin)} ignored`);
  }
  const inv = setting(d, "INVENTORY_ENABLED");
  if (!allowDynamicInventory && changed(inv)) {
    const dyn = (Array.isArray(inv!.value) ? inv!.value.map(String) : []).filter(
      (p) => !["host_list", "yaml", "ini", "toml"].includes(p.replace(/^ansible\.builtin\./, "")),
    );
    if (dyn.length) {
      parts.push(
        `inventory plugins ${dyn.join(", ")} disabled (set ANSIBLE_MCP_ALLOW_DYNAMIC_INVENTORY=1 to allow; they run code)`,
      );
    }
  }
  const vars = setting(d, "VARIABLE_PLUGINS_ENABLED");
  if (changed(vars)) parts.push("vars plugins limited to host_group_vars");
  return parts.length ? `safety: ${parts.join("; ")}.` : "";
}

const GALAXY_SECRETS = new Set(["token", "password", "client_secret"]);
const COLOR_SETTINGS = new Set(["ANSIBLE_NOCOLOR", "ANSIBLE_FORCE_COLOR"]);
export const GALAXY_REDACTED = "(redacted: galaxy credential)";

/** Layer 3 (name) and layer 4 (value shape, URL passwords, inline credentials) for one config value. */
function renderConfigValue(name: string, value: unknown, display: (s: string) => string): string {
  if (isSecretKey(name) && value !== null && value !== undefined && value !== "") return REDACTED_NAME;
  const fix = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (hasSecretShape(v)) return REDACTED_SHAPE;
      const s = v.startsWith("/") ? display(v) : v;
      return maskInlineCredentials(maskUrlPasswords(s) ?? s) ?? maskUrlPasswords(s) ?? s;
    }
    if (Array.isArray(v)) return v.map(fix);
    return v;
  };
  return JSON.stringify(fix(value)) ?? "null";
}

export interface RenderConfigOptions {
  dirLabel: string;
  coreVersion: string;
  all: boolean;
  filter?: string;
  limit: number;
  /** Set when the server set ANSIBLE_CONFIG itself (DrvFs rule, design.md 3.3). */
  drvfsNote?: string;
  display: (p: string) => string;
  /** The local_tmp the server injected; that DEFAULT_LOCAL_TMP row is not the user's setting. */
  hiddenLocalTmp?: string;
}

export function renderConfig(d: ConfigDump, o: RenderConfigOptions): string {
  const cfg = configFile(d);
  const lines = [
    `effective config for ${o.dirLabel} (ansible-core ${o.coreVersion}): config file ${cfg ? o.display(cfg) : "(none)"}${o.drvfsNote ? ` [${o.drvfsNote}]` : ""}`,
  ];
  const q = o.filter?.toLowerCase();
  const rows = d.settings
    .filter((s) => s.name !== "CONFIG_FILE")
    // The colour switches come from the server's own env (clean text to parse), not the user's config.
    .filter(
      (s) => !(COLOR_SETTINGS.has(s.name) && /^env: (ANSIBLE_NOCOLOR|ANSIBLE_FORCE_COLOR|NO_COLOR)$/.test(s.origin)),
    )
    // So does local_tmp: resolving the config creates a dir there, and it must not be ~/.ansible.
    .filter(
      (s) =>
        !(
          o.hiddenLocalTmp &&
          s.name === "DEFAULT_LOCAL_TMP" &&
          s.origin === "env: ANSIBLE_LOCAL_TEMP" &&
          String(s.value).replace(/\\/g, "/").startsWith(o.hiddenLocalTmp.replace(/\\/g, "/"))
        ),
    )
    .filter((s) => o.all || s.origin !== "default")
    .filter((s) => !q || s.name.toLowerCase().includes(q));
  for (const s of rows.slice(0, o.limit)) {
    const origin = cfg && s.origin === cfg ? "ansible.cfg" : s.origin.startsWith("/") ? o.display(s.origin) : s.origin;
    const flag = OVERRIDDEN.has(s.name) && s.origin !== "default" ? " [overridden by ansible-mcp in other tools]" : "";
    lines.push(`  ${s.name} = ${renderConfigValue(s.name, s.value, o.display)}  (${origin || "?"})${flag}`);
  }
  if (rows.length > o.limit) lines.push(`  ... ${rows.length - o.limit} more, narrow with filter`);
  if (rows.length === 0)
    lines.push(q ? `  (no setting matches '${o.filter}')` : "  (no settings changed from the defaults)");
  const servers = Object.entries(d.galaxyServers);
  if (servers.length === 0) {
    lines.push("galaxy servers: (none configured)");
  } else {
    lines.push(`galaxy servers (${servers.length}):`);
    for (const [name, fields] of servers) {
      const parts = (Array.isArray(fields) ? fields : [])
        .filter((f) => f.value !== null && f.value !== undefined && f.value !== "")
        .map((f) =>
          GALAXY_SECRETS.has(f.name)
            ? `${f.name}=${GALAXY_REDACTED}`
            : `${f.name}=${typeof f.value === "string" ? (maskUrlPasswords(f.value) ?? f.value) : JSON.stringify(f.value)}`,
        );
      lines.push(`  ${name}: ${parts.join(" ") || "(defaults)"}`);
    }
  }
  return lines.join("\n");
}

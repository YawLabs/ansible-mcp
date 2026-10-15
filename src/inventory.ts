import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Redactor } from "./redact.js";
import { parseYaml, toJS } from "./yaml.js";

/**
 * ansible_inventory (design.md 7.6). `--graph` gives the structure (and works
 * with whole-file vaults, F6); `--list` / `--host` give vars, which are always
 * redacted. Pure renderers plus the per-file fallback reader.
 */

export interface GraphGroup {
  name: string;
  hosts: string[];
  children: GraphGroup[];
}

/** Parse `ansible-inventory --graph`: `@all:` then `  |--@web:` / `  |  |--web1`. */
export function parseGraph(text: string): GraphGroup | null {
  let root: GraphGroup | null = null;
  const stack: GraphGroup[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let depth = 0;
    let name = raw.trim();
    const i = raw.indexOf("|--");
    if (i >= 0) {
      depth = Math.round((i - 2) / 3) + 1;
      name = raw.slice(i + 3).trim();
    }
    if (name.startsWith("@")) {
      const g: GraphGroup = { name: name.slice(1).replace(/:$/, ""), hosts: [], children: [] };
      if (depth === 0) {
        root = g;
        stack.length = 0;
        stack.push(g);
      } else {
        stack.length = depth;
        stack[depth - 1]?.children.push(g);
        stack.push(g);
      }
    } else {
      stack[depth - 1]?.hosts.push(name);
    }
  }
  return root;
}

export function graphStats(root: GraphGroup): { hosts: Set<string>; groups: Set<string> } {
  const hosts = new Set<string>();
  const groups = new Set<string>();
  const walk = (g: GraphGroup) => {
    groups.add(g.name);
    for (const h of g.hosts) hosts.add(h);
    for (const c of g.children) walk(c);
  };
  walk(root);
  return { hosts, groups };
}

/** Groups a host belongs to, directly or through child groups (all > staging > web). */
export function groupsOf(root: GraphGroup, host: string): string[] {
  const out = new Set<string>();
  const walk = (g: GraphGroup, chain: string[]): void => {
    const next = [...chain, g.name];
    if (g.hosts.includes(host)) for (const n of next) out.add(n);
    for (const c of g.children) walk(c, next);
  };
  walk(root, []);
  return [...out].sort();
}

export function renderGraph(root: GraphGroup, hostLimit: number): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  let shown = 0;
  const walk = (g: GraphGroup, depth: number) => {
    const pad = "  ".repeat(depth);
    if (seen.has(g.name) && depth > 0) {
      lines.push(`${pad}@${g.name}`);
      return;
    }
    seen.add(g.name);
    const hosts = g.hosts.slice(0, Math.max(0, hostLimit - shown));
    shown += hosts.length;
    const more = g.hosts.length > hosts.length ? ` ... (+${g.hosts.length - hosts.length} more)` : "";
    lines.push(`${pad}@${g.name}:${hosts.length ? ` ${hosts.join(", ")}` : ""}${more}`);
    for (const c of g.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return lines;
}

export interface ListDoc {
  _meta?: { hostvars?: Record<string, Record<string, unknown>> };
  [group: string]: unknown;
}

export const VARS_SCOPE_NOTE =
  "vars are inventory-level only (group_vars/host_vars and inventory files; play, role and fact vars are not included); values are not templated";

/** Var names per host (`vars: names`). */
export function renderVarNames(list: ListDoc, hosts: string[]): string[] {
  const hv = list._meta?.hostvars ?? {};
  return hosts.map(
    (h) =>
      `  ${h}: ${
        Object.keys(hv[h] ?? {})
          .sort()
          .join(" ") || "(none)"
      }`,
  );
}

/** `name = value` lines for one host's vars, redacted. */
export function renderHostVars(vars: Record<string, unknown>, red: Redactor, indent = "  "): string[] {
  return Object.keys(vars)
    .sort()
    .map((k) => `${indent}${k} = ${red.render(vars[k], [k])}`);
}

export function learnAll(red: Redactor, hostvars: Record<string, Record<string, unknown>>): void {
  for (const vars of Object.values(hostvars)) for (const [k, v] of Object.entries(vars)) red.learn(v, [k]);
}

/** Dynamic sources skipped because script/auto/constructed are disabled (F8). */
export function skippedSources(stderr: string): string[] {
  const out: string[] = [];
  for (const m of stderr.matchAll(/Unable to parse (\S+) as an inventory source/g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

export function isVaultFailure(stderr: string): boolean {
  return /Attempting to decrypt but no vault secrets found|Decryption failed/.test(stderr);
}

export function hostMissing(stderr: string): boolean {
  return /Could not match supplied host pattern|You must pass a single valid host/.test(stderr);
}

/** Every group_vars / host_vars file under `base` (subdirs like group_vars/all/ included). */
export function varsFiles(base: string): { kind: "group_vars" | "host_vars"; owner: string; abs: string }[] {
  const out: { kind: "group_vars" | "host_vars"; owner: string; abs: string }[] = [];
  for (const kind of ["group_vars", "host_vars"] as const) {
    const root = join(base, kind);
    let entries: string[];
    try {
      entries = readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(root, e);
      let st: import("node:fs").Stats;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        for (const f of readdirSync(p).sort()) {
          if (/(\.ya?ml|\.json)$/i.test(f) || !f.includes(".")) out.push({ kind, owner: e, abs: join(p, f) });
        }
      } else if (/(\.ya?ml|\.json)$/i.test(e) || !e.includes(".")) {
        out.push({ kind, owner: e.replace(/\.(ya?ml|json)$/i, ""), abs: p });
      }
    }
  }
  return out;
}

/**
 * The degraded view when a whole-file vault blocks `--list`: each vars file's
 * top-level keys and redacted values, without Ansible's precedence merge.
 * Whole-file vaults are listed, never read.
 */
export function renderVarsFilesFallback(
  bases: { base: string; label: string }[],
  rel: (abs: string) => string,
  red: Redactor,
): { lines: string[]; vaulted: string[] } {
  const lines: string[] = [];
  const vaulted: string[] = [];
  const parsed: { label: string; values: Record<string, unknown> | null }[] = [];
  for (const { base } of bases) {
    for (const f of varsFiles(base)) {
      let text = "";
      try {
        text = readFileSync(f.abs, "utf8");
      } catch {
        continue;
      }
      if (/^\s*\$ANSIBLE_VAULT;/.test(text)) {
        vaulted.push(rel(f.abs));
        parsed.push({ label: `${rel(f.abs)} (${f.kind} ${f.owner})`, values: null });
        continue;
      }
      const v = toJS(parseYaml(text).root);
      parsed.push({
        label: `${rel(f.abs)} (${f.kind} ${f.owner})`,
        values: v && typeof v === "object" ? (v as Record<string, unknown>) : {},
      });
    }
  }
  for (const p of parsed) for (const [k, v] of Object.entries(p.values ?? {})) red.learn(v, [k]);
  for (const p of parsed) {
    lines.push(`  ${p.label}:`);
    if (p.values === null) {
      lines.push("    <vaulted file, not read>");
      continue;
    }
    const ks = Object.keys(p.values);
    if (ks.length === 0) lines.push("    (empty)");
    for (const k of ks) lines.push(`    ${k} = ${red.render(p.values[k], [k])}`);
  }
  return { lines, vaulted };
}

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { importPlaybookEntry, isDir, isPlaybookLike, type ProjectFiles, yamlFilesUnder } from "./project.js";
import { ALIAS_LIMIT_ERROR, get, isTemplated, type YNode } from "./yaml.js";

/**
 * ansible_playbook_structure (design.md 7.7) and the lookup pre-scan (R1).
 * Pure parsing of `--list-tasks --list-hosts --list-tags` text (F13) and of
 * stderr `[ERROR]` / `[DEPRECATION WARNING]` blocks with their `Origin:` (F14, F16).
 */

export interface ListedTask {
  role?: string;
  name: string;
  tags: string[];
}

export interface ListedPlay {
  index: number;
  pattern: string;
  name: string;
  tags: string[];
  hosts: string[] | null;
  hostCount: number | null;
  tasks: ListedTask[];
  taskTags: string[];
}

const tagList = (s: string | undefined): string[] =>
  (s ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export function parseListOutput(text: string): ListedPlay[] {
  const plays: ListedPlay[] = [];
  let cur: ListedPlay | null = null;
  let section: "hosts" | "tasks" | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const play = /^ {2}play #(\d+) \(([^)]*)\): (.*?)\tTAGS: (\[.*\])\s*$/.exec(raw);
    if (play) {
      cur = {
        index: Number(play[1]),
        pattern: play[2]!,
        name: play[3]!,
        tags: tagList(play[4]),
        hosts: null,
        hostCount: null,
        tasks: [],
        taskTags: [],
      };
      plays.push(cur);
      section = null;
      continue;
    }
    if (!cur) continue;
    const hosts = /^ {4}hosts \((\d+)\):\s*$/.exec(raw);
    if (hosts) {
      cur.hostCount = Number(hosts[1]);
      cur.hosts = [];
      section = "hosts";
      continue;
    }
    if (/^ {4}tasks:\s*$/.test(raw)) {
      section = "tasks";
      continue;
    }
    if (/^ {4}pattern: /.test(raw)) continue;
    const tt = /^ {6}TASK TAGS: (\[.*\])\s*$/.exec(raw);
    if (tt) {
      cur.taskTags = tagList(tt[1]);
      continue;
    }
    const line = /^ {6}(\S.*)$/.exec(raw);
    if (!line) continue;
    if (section === "hosts") {
      cur.hosts!.push(line[1]!.trim());
    } else if (section === "tasks") {
      const m = /^(.*?)\tTAGS: (\[.*\])\s*$/.exec(line[1]!);
      const body = m ? m[1]! : line[1]!;
      const rm = /^([^\s:][^:]*?) : (.*)$/.exec(body);
      cur.tasks.push({
        ...(rm ? { role: rm[1]!, name: rm[2]! } : { name: body }),
        tags: tagList(m?.[2]),
      });
    }
  }
  return plays;
}

export interface StderrMessage {
  kind: "ERROR" | "DEPRECATION WARNING" | "WARNING";
  text: string;
  origin?: { file: string; line: number; col?: number };
}

/** `[ERROR]: text` / `[DEPRECATION WARNING]: text` + an optional `Origin: file:line:col` line. */
export function parseStderrMessages(stderr: string): StderrMessage[] {
  const out: StderrMessage[] = [];
  let cur: StderrMessage | null = null;
  for (const raw of stderr.split(/\r?\n/)) {
    const m = /^\[(ERROR|DEPRECATION WARNING|WARNING)\]: (.*)$/.exec(raw);
    if (m) {
      cur = { kind: m[1] as StderrMessage["kind"], text: m[2]!.trim() };
      out.push(cur);
      continue;
    }
    const o = /^Origin: (.+?):(\d+)(?::(\d+))?\s*$/.exec(raw);
    if (o && cur && !cur.origin) {
      cur.origin = { file: o[1]!, line: Number(o[2]), ...(o[3] ? { col: Number(o[3]) } : {}) };
    }
  }
  return out;
}

/** The first sentence of an Ansible error (drops "This often indicates ..." boilerplate). */
export function firstSentence(text: string): string {
  const i = text.search(/\.\s+(?=[A-Z])/);
  return (i > 0 ? text.slice(0, i) : text).replace(/\.$/, "");
}

/**
 * Any mention of the lookup functions, not only a direct call: Jinja can bind
 * them first (`{% set f = lookup %}{{ f(...) }}`, `(lookup)(...)`). The short
 * name `q` is flagged as a whole word anywhere from the first `{{` / `{%` on
 * (`{% set f = q %}`, `(q)(...)`), so a plain-text letter q is not; the rest
 * of the string is searched rather than each block, since a `}}` inside a
 * Jinja string literal would end a block match early.
 */
const LOOKUP_RE = /\b(?:lookup|query|pipe)\b/;
const Q_RE = /\bq\b/;

export function mentionsLookup(s: string): boolean {
  if (LOOKUP_RE.test(s)) return true;
  const open = s.search(/\{[{%]/);
  return open >= 0 && Q_RE.test(s.slice(open));
}

/** Parse cap for the pre-scan: well above ProjectFiles' 2 MiB default, so a big playbook is still read. */
const PRESCAN_MAX_BYTES = 32 * 1024 * 1024;

export interface PrescanHit {
  file: string;
  line: number;
  play: string;
  field: string;
  /** Set when the file could not be read or fully parsed, so it cannot be shown clean. */
  unreadable?: string;
}

/**
 * R1 mitigation: walk the playbook (following literal import_playbook) and
 * find lookups in play-level fields Ansible templates while parsing (F10).
 */
export function prescanPlaybook(files: ProjectFiles, rel: string): PrescanHit[] {
  const hits: PrescanHit[] = [];
  const seen = new Set<string>();
  const visit = (abs: string) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    const file = files.rel(abs);
    // A target Ansible will read but we cannot (missing, unreadable, too big,
    // or cut short by the alias limit) is refused, never counted clean.
    const doc = files.read(abs, PRESCAN_MAX_BYTES);
    if (!doc) {
      hits.push({ file, line: 0, play: "", field: "", unreadable: "could not be read" });
      return;
    }
    if (doc.errors.some((e) => e.startsWith(ALIAS_LIMIT_ERROR))) {
      hits.push({ file, line: 0, play: "", field: "", unreadable: `could not be fully parsed (${ALIAS_LIMIT_ERROR})` });
      return;
    }
    const root = doc.root;
    if (root?.kind !== "seq") return;
    for (const play of root.items) {
      if (play.kind !== "map") continue;
      const nameNode = get(play, "name");
      const label =
        nameNode?.kind === "scalar" && typeof nameNode.value === "string" ? nameNode.value : `#${play.line}`;
      const check = (field: string, node: YNode | undefined) => {
        for (const s of strings(node)) {
          if (mentionsLookup(s.value)) hits.push({ file, line: s.line, play: label, field });
        }
      };
      check("name", nameNode);
      check("hosts", get(play, "hosts"));
      check("vars_files", get(play, "vars_files"));
      const imp = importPlaybookEntry(play);
      if (imp) {
        check("import_playbook", imp);
        const target = imp.kind === "scalar" && typeof imp.value === "string" ? imp.value : null;
        if (target && !isTemplated(target)) {
          // A missing import fails Ansible's parse before any play is templated.
          const p = join(dirname(abs), target);
          if (existsSync(p)) visit(p);
        }
      }
    }
  };
  visit(files.abs(rel));
  return hits;
}

/**
 * R1 for lint targets (ansible-lint lints everything under a directory): a
 * file target, and every .yml/.yaml file below a directory target at any
 * depth, is read and pre-scanned when its root looks like a playbook (or when
 * it cannot be read). A walk that hits its safety bound, or a dir it cannot
 * list, is a refusal: what was not seen is not clean. Missing paths are left
 * to ansible-lint's own error.
 */
export function prescanLintTargets(files: ProjectFiles, paths: string[], maxEntries?: number): PrescanHit[] {
  const hits: PrescanHit[] = [];
  const seen = new Set<string>();
  const scanFile = (abs: string) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    const doc = files.read(abs, PRESCAN_MAX_BYTES);
    if (doc && !doc.errors.some((e) => e.startsWith(ALIAS_LIMIT_ERROR)) && !isPlaybookLike(doc.root)) return;
    hits.push(...prescanPlaybook(files, abs));
  };
  for (const p of paths) {
    if (isDir(p)) {
      const walk = yamlFilesUnder(p, maxEntries);
      if (walk.incomplete) {
        hits.push({ file: files.rel(p), line: 0, play: "", field: "", unreadable: walk.incomplete });
      }
      for (const abs of walk.files) scanFile(abs);
    } else if (existsSync(p)) {
      scanFile(p);
    }
  }
  return hits;
}

function strings(node: YNode | undefined): { value: string; line: number }[] {
  if (!node) return [];
  if (node.kind === "scalar") return typeof node.value === "string" ? [{ value: node.value, line: node.line }] : [];
  if (node.kind === "seq") return node.items.flatMap(strings);
  return node.entries.flatMap((e) => strings(e.value));
}

export function prescanRefusal(hits: PrescanHit[]): string {
  const lines = hits.map((h) =>
    h.unreadable
      ? `${h.file} ${h.unreadable} for the lookup pre-scan; Ansible would parse it. Not run.`
      : `${h.file}:${h.line} play '${h.play}' has a lookup in '${h.field}'; Ansible would run it on this machine while parsing. Not run.`,
  );
  lines.push("Set ANSIBLE_MCP_ALLOW_PLAY_LOOKUPS=1 to allow.");
  return lines.join("\n");
}

/** Playbook-adjacent plugin dirs that Ansible imports while parsing (R1). */
export function localPluginFiles(files: ProjectFiles, playbookRel: string): string[] {
  const dirs = new Set([dirname(files.abs(playbookRel)), files.dir]);
  const out: string[] = [];
  for (const d of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const e of entries.sort()) {
      if (!/^(library|module_utils|.+_plugins)$/.test(e) || !isDir(join(d, e))) continue;
      for (const f of readdirSync(join(d, e)).sort()) {
        if (/\.py$/.test(f)) {
          const rel = files.rel(join(d, e, f));
          if (!out.includes(rel)) out.push(rel);
        }
      }
    }
  }
  return out;
}

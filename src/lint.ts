import { redactText } from "./redact.js";

/**
 * ansible_lint_summary (design.md 7.10, F17): `ansible-lint --offline -f
 * codeclimate` grouped by rule. Exit 0 = clean, 2 = violations; anything else
 * is an error. Messages pass through layer-4 redaction (`args[module]` prints
 * `got: <value>`). Pure.
 */

export interface LintIssue {
  check: string;
  severity: string;
  categories: string[];
  description: string;
  url?: string;
  path: string;
  line: number;
}

export function parseCodeclimate(text: string): LintIssue[] {
  const t = text.trim();
  if (!t) return [];
  let data: unknown;
  try {
    data = JSON.parse(t);
  } catch {
    throw new Error("ansible-lint did not print a JSON report.");
  }
  if (!Array.isArray(data)) throw new Error("ansible-lint's JSON report is not an array.");
  return data.map((x: any) => ({
    check: String(x?.check_name ?? "?"),
    severity: String(x?.severity ?? ""),
    categories: Array.isArray(x?.categories) ? x.categories.map(String) : [],
    description: String(x?.description ?? ""),
    url: x?.url,
    path: String(x?.location?.path ?? "?"),
    line: Number(x?.location?.lines?.begin ?? x?.location?.positions?.begin?.line ?? 0),
  }));
}

export interface LintSummaryLine {
  failures: number;
  warnings: number;
  files?: number;
}

export function parseLintSummary(stderr: string): LintSummaryLine | null {
  const m = /(?:Failed|Passed): (\d+) failure\(s\), (\d+) warning\(s\)(?: in (\d+) files processed)?/.exec(stderr);
  if (!m) return null;
  return { failures: Number(m[1]), warnings: Number(m[2]), ...(m[3] ? { files: Number(m[3]) } : {}) };
}

/** Vault files lint could not decrypt (expected: the server never supplies a secret). */
export function lintVaultWarnings(stderr: string): string[] {
  const out: string[] = [];
  for (const m of stderr.matchAll(/while processing (\S+) \([^)]*\): Decryption failed/g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

const kindOf = (severity: string) => (severity === "minor" || severity === "info" ? "warning" : "failure");

function normalizeDescription(d: string): string {
  return d
    .replace(/,? such `[^`]*`\.?$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function renderLint(
  version: string,
  issues: LintIssue[],
  stderr: string,
  maxLocations: number,
  profile?: string,
): string {
  const summary = parseLintSummary(stderr);
  const failures = summary?.failures ?? issues.filter((i) => kindOf(i.severity) === "failure").length;
  const warnings = summary?.warnings ?? issues.filter((i) => kindOf(i.severity) === "warning").length;
  const files = summary?.files !== undefined ? ` in ${summary.files} files` : "";
  const lines = [
    `ansible-lint ${version} (offline${profile ? `, profile ${profile}` : ""}): ${failures} failure${failures === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}${files}`,
  ];
  const groups = new Map<string, LintIssue[]>();
  for (const i of issues) {
    const g = groups.get(i.check) ?? [];
    g.push(i);
    groups.set(i.check, g);
  }
  const ordered = [...groups.entries()].sort(([a, x], [b, y]) => y.length - x.length || (a < b ? -1 : 1));
  for (const [check, list] of ordered) {
    const first = list[0]!;
    const descs = [...new Set(list.map((i) => normalizeDescription(redactText(i.description))))];
    let desc = descs.slice(0, 2).join(" | ");
    if (descs.length > 2) desc += " | ...";
    if (desc.length > 200) desc = `${desc.slice(0, 200)}...`;
    lines.push(
      `${check} x${list.length} (${kindOf(first.severity)}${first.categories.length ? `, ${first.categories.join("/")}` : ""})${desc ? ` - ${desc}` : ""}`,
    );
    if (maxLocations > 0) {
      const locs = list.slice(0, maxLocations).map((i) => `${i.path}:${i.line}`);
      const more = list.length > maxLocations ? `, ... ${list.length - maxLocations} more` : "";
      lines.push(`  ${locs.join(", ")}${more}`);
    }
  }
  if (issues.length === 0) lines.push("no violations");
  const perFile = new Map<string, number>();
  for (const i of issues) perFile.set(i.path, (perFile.get(i.path) ?? 0) + 1);
  if (perFile.size > 1) {
    const top = [...perFile.entries()].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).slice(0, 5);
    lines.push(`top files: ${top.map(([f, n]) => `${f} (${n})`).join(", ")}`);
  }
  const vault = lintVaultWarnings(stderr);
  if (vault.length) {
    lines.push(
      `lint warnings (not violations): ${vault.map((f) => `${f} could not be decrypted`).join(", ")} (expected: no vault secrets)`,
    );
  }
  return lines.join("\n");
}

/**
 * Collection version constraints, evaluated the way `ansible-galaxy` does
 * (ansible.galaxy.dependency_resolution.versioning.meets_requirements):
 *
 * - comma-separated clauses are ANDed;
 * - operators `==`, `!=`, `>=`, `>`, `<=`, `<`, and `*` (any version);
 * - a bare version means `==`;
 * - a pre-release satisfies only constraints that name a pre-release
 *   (galaxy skips pre-releases unless one is requested).
 *
 * The same evaluator reads `requires_ansible` from meta/runtime.yml, which uses
 * PEP 440 specifiers of the same shape for every value collections ship.
 *
 * Pure: no I/O.
 */

export interface Version {
  parts: number[];
  pre: string;
}

const VERSION_RE =
  /^v?(\d+(?:\.\d+)*)(?:[-.]?((?:a|b|rc|alpha|beta|dev|pre)[0-9A-Za-z.-]*|[0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Exact version as `ansible_upgrade_impact` accepts it. */
export const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(s: string): Version | null {
  const t = s.trim();
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(t) ?? VERSION_RE.exec(t);
  if (!m) return null;
  return { parts: m[1]!.split(".").map(Number), pre: m[2] ?? "" };
}

/**
 * Compare one prerelease segment. `packaging` (what galaxy uses) compares a
 * segment by its numeric run, so `rc2` < `rc10`; a plain string compare would
 * order `rc10` first. Segments with no digits compare case-insensitively.
 */
function comparePrePart(x: string, y: string): number {
  const mx = /^(.*?)(\d+)$/.exec(x);
  const my = /^(.*?)(\d+)$/.exec(y);
  if (mx && my) {
    if (mx[1] !== my[1]) return mx[1] < my[1] ? -1 : 1;
    const d = Number(mx[2]) - Number(my[2]);
    return d === 0 ? 0 : d < 0 ? -1 : 1;
  }
  const a = x.toLowerCase();
  const b = y.toLowerCase();
  return a === b ? 0 : a < b ? -1 : 1;
}

function comparePre(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else {
      const d = comparePrePart(x, y);
      if (d !== 0) return d;
    }
  }
  return 0;
}

export function compareVersions(a: Version | string, b: Version | string): number {
  const va = typeof a === "string" ? parseVersion(a) : a;
  const vb = typeof b === "string" ? parseVersion(b) : b;
  if (!va || !vb) throw new ConstraintSyntaxError(`invalid version "${String(!va ? a : b)}"`);
  const n = Math.max(va.parts.length, vb.parts.length);
  for (let i = 0; i < n; i++) {
    const x = va.parts[i] ?? 0;
    const y = vb.parts[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePre(va.pre, vb.pre);
}

export class ConstraintSyntaxError extends Error {}

interface Clause {
  op: "==" | "!=" | ">=" | ">" | "<=" | "<" | "*";
  version: Version | null;
}

export function parseConstraint(text: string): Clause[] {
  const clauses: Clause[] = [];
  for (const raw of String(text).split(",")) {
    const part = raw.trim();
    if (!part) throw new ConstraintSyntaxError(`empty clause in version constraint "${text}"`);
    if (part === "*") {
      clauses.push({ op: "*", version: null });
      continue;
    }
    const m = /^(==|!=|>=|<=|>|<|=)?\s*(.+)$/.exec(part);
    let op = (m?.[1] ?? "==") as string;
    if (op === "=") op = "==";
    const vtext = (m?.[2] ?? "").trim();
    const version = parseVersion(vtext);
    if (!version) throw new ConstraintSyntaxError(`invalid version "${vtext}" in constraint "${text}"`);
    clauses.push({ op: op as Clause["op"], version });
  }
  return clauses;
}

/** Does `version` satisfy `constraint`? Throws ConstraintSyntaxError on bad syntax. */
export function satisfies(version: string, constraint: string | number): boolean {
  const v = parseVersion(version);
  if (!v) throw new ConstraintSyntaxError(`invalid version "${version}"`);
  const clauses = parseConstraint(String(constraint));
  // A pre-release satisfies only constraints that name a pre-release -- but a
  // constraint with no version bound at all (`*`) excludes nothing.
  const bounded = clauses.filter((c) => c.op !== "*");
  if (v.pre && bounded.length && !bounded.some((c) => c.version?.pre)) return false;
  return clauses.every((c) => {
    if (c.op === "*") return true;
    const cmp = compareVersions(v, c.version!);
    switch (c.op) {
      case "==":
        return cmp === 0;
      case "!=":
        return cmp !== 0;
      case ">=":
        return cmp >= 0;
      case ">":
        return cmp > 0;
      case "<=":
        return cmp <= 0;
      case "<":
        return cmp < 0;
    }
    return false;
  });
}

/** `major` / `minor` / `patch` / `prerelease` distance between two versions. */
export function bumpKind(from: string, to: string): "major" | "minor" | "patch" | "prerelease" | "same" {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return "same";
  for (const [i, name] of (["major", "minor", "patch"] as const).entries()) {
    if ((a.parts[i] ?? 0) !== (b.parts[i] ?? 0)) return name;
  }
  return a.pre !== b.pre ? "prerelease" : "same";
}

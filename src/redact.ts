/**
 * Redaction for every value this server prints from inventory, role defaults,
 * config, lint messages or task arguments (design.md section 5). Pure: no I/O.
 *
 * Ported from terraform-cwd-mcp's four layers and adapted to what Ansible
 * actually emits:
 *
 * 1. Ansible markers: `{"__ansible_vault": ...}` (inline vault) and any string
 *    starting with `$ANSIBLE_VAULT;` become `<vaulted>`; `{"__ansible_unsafe": v}`
 *    is unwrapped to `v` first (the unsafe tag is not a secret). `no_log`
 *    options are handled by the callers, which know the option specs.
 * 2. Value matching: a string equal to (or, for >= 8 chars, containing) a
 *    string that layer 1, 3 or 4 redacted elsewhere in the same document.
 * 3. Key names: a string, number or bool under a secret-like own or ancestor
 *    key (`ansible_become_password`, `api_token`, `vault_db_password`).
 * 4. Value shape: private keys, JWTs, well-known token prefixes, vault text;
 *    URL passwords and inline `password=...` credentials are masked in place.
 */

export const VAULTED = "<vaulted>";
export const REDACTED_VALUE = "(redacted: contains a secret value)";
export const REDACTED_NAME = "(redacted: secret-like name)";
export const REDACTED_SHAPE = "(redacted: secret-like value)";
export const NO_LOG = "(no_log)";
export const TEMPLATE_NOTE = "(template, not rendered)";

// --- Layer 3: key names -----------------------------------------------------

const SECRET_TOKENS = new Set([
  "password",
  "passwd",
  "pwd",
  "pass",
  "passphrase",
  "secret",
  "secrets",
  "token",
  "tokens",
  "apikey",
  "privatekey",
  "credential",
  "credentials",
  "creds",
  "auth",
  "authorization",
  "bearer",
  "cookie",
  "session",
  "sas",
  "signature",
  "kubeconfig",
  "pfx",
  "p12",
  "otp",
  "pin",
  "salt",
  "connectionstring",
]);

const SECRET_PAIRS = new Set([
  "private key",
  "api key",
  "access key",
  "secret key",
  "client secret",
  "connection string",
  "master key",
  "account key",
  "shared key",
  "signing key",
  "encryption key",
]);

/** A key whose LAST token is one of these names metadata about a secret, not the secret. */
const METADATA_TOKENS = new Set([
  "arn",
  "arns",
  "id",
  "ids",
  "name",
  "names",
  "type",
  "types",
  "version",
  "versions",
  "length",
  "count",
  "enabled",
  "disabled",
  "required",
  "ttl",
  "algorithm",
  "fingerprint",
  "expiration",
  "expiry",
  "expires",
  "policy",
  "policies",
  "rotation",
  "path",
  "file",
  "filename",
  "url",
  "uri",
  "endpoint",
  "hash",
  "md5",
  "format",
  "mode",
  "status",
  "state",
  "location",
  "region",
  "zone",
  "label",
  "labels",
  "description",
  "prefix",
  "suffix",
  "size",
  "bits",
  "kind",
  "min",
  "max",
  "timeout",
  "duration",
  "period",
  "days",
  "date",
  "time",
  "timestamp",
  "created",
  "updated",
  "source",
  "strategy",
  "ref",
  "reference",
  // Ansible: `vault_addr` / `vault_address` name a Vault server, not a secret.
  "addr",
  "address",
]);

/** Split a key into lowercase tokens on `_`, `-`, `.`, spaces and camelCase boundaries. */
export function tokenizeKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/** Run-together words that contain a secret word but name a service, not a secret. */
const NOT_SECRET_TOKENS = new Set(["secretsmanager"]);

function isSecretToken(t: string): boolean {
  if (SECRET_TOKENS.has(t)) return true;
  if (t.length > 4 && t.endsWith("s") && SECRET_TOKENS.has(t.slice(0, -1))) return true;
  if (NOT_SECRET_TOKENS.has(t)) return false;
  // Env-var style names with no separator: PGPASSWORD, ADMINPASSWORD, MYSQLPWD, GITHUBTOKEN.
  if (/password|passwd|secret/.test(t)) return true;
  return /(pwd|token|apikey|privatekey)$/.test(t);
}

function isMetadataToken(t: string): boolean {
  return METADATA_TOKENS.has(t) || /^sha\d*$/.test(t);
}

/**
 * True when a key names a secret (`db_password`, `ansible_become_pass`,
 * `vault_db_password`) and not metadata about one (`password_length`,
 * `vault_addr`, `private_key_file`).
 */
export function isSecretKey(key: string): boolean {
  const tokens = tokenizeKey(key);
  if (tokens.length === 0) return false;
  if (isMetadataToken(tokens[tokens.length - 1]!)) return false;
  // Ansible's documented convention: `vault_<name>` holds the vaulted value.
  if (tokens[0] === "vault" && tokens.length > 1) return true;
  for (let i = 0; i < tokens.length; i++) {
    if (isSecretToken(tokens[i]!)) return true;
    if (i + 1 < tokens.length && SECRET_PAIRS.has(`${tokens[i]} ${tokens[i + 1]}`)) return true;
  }
  return false;
}

// --- Layer 4: value shape ---------------------------------------------------

const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/,
  /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/, // JWT (header.payload.signature)
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  // base64 of "-----BEGIN ... PRIVATE KEY" (kubeconfig client-key-data): the three alignments of "PRIVATE KEY".
  /LS0tLS1CRUdJTi[A-Za-z0-9+/=]{0,40}(UFJJVkFURSBLRVk|BSSVZBVEUgS0VZ|UklWQVRFIEtFW)/,
];

const VAULT_TEXT = /^\s*\$ANSIBLE_VAULT;/;

// The username may be empty: `redis://:password@host` is Redis's documented form.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]*):([^\s@/]+)@/gi;

export function hasSecretShape(s: string): boolean {
  return SHAPES.some((re) => re.test(s));
}

export function isVaultText(s: string): boolean {
  return VAULT_TEXT.test(s);
}

/** Replace the password in `scheme://user:pass@host` with `(redacted)`. Returns null when there is none. */
export function maskUrlPasswords(s: string): string | null {
  URL_USERINFO.lastIndex = 0;
  if (!URL_USERINFO.test(s)) return null;
  URL_USERINFO.lastIndex = 0;
  return s.replace(URL_USERINFO, "$1$2:(redacted)@");
}

/**
 * `Password=x;`, `--password=x`, `"token": "x"`, `AccountKey=x` inside a longer
 * string (connection strings, command lines, embedded JSON). The key may carry a
 * prefix joined by `_` / `-` (`aws_secret_access_key=`).
 */
const INLINE_CREDENTIAL =
  /\b((?:[a-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|account[_-]?key|shared[_-]?access[_-]?key|client[_-]?secret)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^;\s&"',]+)/gi;

/** Mask inline `key=value` credentials. Returns null when there is none. */
export function maskInlineCredentials(s: string): string | null {
  INLINE_CREDENTIAL.lastIndex = 0;
  if (!INLINE_CREDENTIAL.test(s)) return null;
  INLINE_CREDENTIAL.lastIndex = 0;
  return s.replace(INLINE_CREDENTIAL, (_m, key: string, value: string) => {
    const q = value[0] === '"' || value[0] === "'" ? value[0] : "";
    return `${key}${q}(redacted)${q}`;
  });
}

/**
 * Layer 4 for free text (lint messages, stderr excerpts): secret-shaped tokens
 * and vault text are replaced, URL passwords and inline credentials masked.
 */
export function redactText(s: string): string {
  let out = s;
  for (const re of SHAPES) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    out = out.replace(g, REDACTED_SHAPE);
  }
  out = out.replace(/\$ANSIBLE_VAULT;[^\s"']*(\s+[0-9a-f]+)*/g, VAULTED);
  out = maskUrlPasswords(out) ?? out;
  out = maskInlineCredentials(out) ?? out;
  return out;
}

/**
 * The passwords layer 4 masks IN PLACE (URL userinfo, inline credentials).
 * `learn()` must register these too: a URL-embedded password that is masked in
 * the URL but appears verbatim under a later benign key would otherwise print
 * in the clear, because layer 2 only knows strings layers 1/3/shape hid.
 */
export function maskedSecretValues(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(new RegExp(URL_USERINFO.source, "gi"))) if (m[3]) out.push(m[3]);
  for (const m of s.matchAll(new RegExp(INLINE_CREDENTIAL.source, "gi"))) {
    const raw = m[2];
    if (!raw) continue;
    const unq = raw[0] === '"' || raw[0] === "'" ? raw.slice(1, -1) : raw;
    if (unq) out.push(unq);
  }
  return out;
}

// --- Ansible markers --------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function isVaultMarker(v: unknown): boolean {
  return isPlainObject(v) && Object.hasOwn(v, "__ansible_vault");
}

/** `{"__ansible_unsafe": v}` -> v, recursively. */
export function unwrapUnsafe(v: unknown): unknown {
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "__ansible_unsafe") return unwrapUnsafe(v.__ansible_unsafe);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = unwrapUnsafe(x);
    return out;
  }
  if (Array.isArray(v)) return v.map(unwrapUnsafe);
  return v;
}

/** A value that is exactly one Jinja expression with no quotes inside: a reference, not a secret. */
export function isPlainTemplateRef(s: string): boolean {
  return /^\s*\{\{[^'"{}]*\}\}\s*$/.test(s);
}

// --- Applying the layers ------------------------------------------------------

export interface RedactionCounts {
  vaulted: number;
  name: number;
  value: number;
  shape: number;
  url: number;
}

/** Sentinel leaf: printed bare at top level, as a JSON string when nested. */
class Hidden {
  constructor(readonly text: string) {}
}

/**
 * One redaction pass over a document (an inventory listing, a defaults file,
 * a config dump). Call `learn()` on every value first (layer 2 needs the set of
 * strings the other layers hide), then `render()` each value to print.
 */
export class Redactor {
  readonly counts: RedactionCounts = { vaulted: 0, name: 0, value: 0, shape: 0, url: 0 };
  private readonly secrets = new Set<string>();
  private long: string[] = [];

  /** Collect strings that layers 1, 3 and 4 would hide, for layer 2. */
  learn(value: unknown, keys: string[] = []): void {
    const v = unwrapUnsafe(value);
    if (isVaultMarker(v)) return;
    if (typeof v === "string") {
      if (v.length < 4 || isPlainTemplateRef(v)) return;
      if (isVaultText(v) || keys.some(isSecretKey) || hasSecretShape(v)) this.addSecret(v);
      // Passwords layer 4 masks in place (URL userinfo, inline credentials).
      else for (const s of maskedSecretValues(v)) this.addSecret(s);
      return;
    }
    if (typeof v === "number" && keys.some(isSecretKey)) {
      if (String(v).length >= 4) this.addSecret(String(v));
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) this.learn(x, keys);
    } else if (isPlainObject(v)) {
      for (const [k, x] of Object.entries(v)) this.learn(x, [...keys, k]);
    }
  }

  /** Mark a string as secret (e.g. a `no_log` default) so copies of it are caught. */
  addSecret(s: string): void {
    if (s.length < 4 || this.secrets.has(s)) return;
    this.secrets.add(s);
    if (s.length >= 8) this.long.push(s);
  }

  private matches(s: string): boolean {
    return this.secrets.has(s) || this.long.some((x) => s.includes(x));
  }

  private leaf(v: unknown, keys: string[], top: boolean): unknown {
    if (isVaultMarker(v)) {
      this.counts.vaulted++;
      return new Hidden(VAULTED);
    }
    if (typeof v === "string") {
      if (isVaultText(v)) {
        this.counts.vaulted++;
        return new Hidden(VAULTED);
      }
      if (isPlainTemplateRef(v)) return top ? new Hidden(`${JSON.stringify(v)} ${TEMPLATE_NOTE}`) : v;
      if (keys.some(isSecretKey)) {
        this.counts.name++;
        return new Hidden(REDACTED_NAME);
      }
      if (hasSecretShape(v)) {
        this.counts.shape++;
        return new Hidden(REDACTED_SHAPE);
      }
      // The whole string is a known secret: strongest, and checked before the
      // in-place masks so an exact match hides the value entirely.
      if (this.secrets.has(v)) {
        this.counts.value++;
        return new Hidden(REDACTED_VALUE);
      }
      // A string carrying its own credentials is surgically masked, not
      // blanket-redacted: the substring match must not fire on a URL merely
      // because it contains the password `learn()` recorded from it. So layer 2
      // runs on the MASKED string, which still catches a secret learned
      // elsewhere (`https://u:pw@h/<learned secret>`).
      const url = maskUrlPasswords(v);
      if (url !== null) this.counts.url++;
      const inline = maskInlineCredentials(url ?? v);
      if (inline !== null) this.counts.shape++;
      const masked = inline ?? url;
      if (masked !== null) {
        if (!this.matches(masked)) return masked;
        this.counts.value++;
        return new Hidden(REDACTED_VALUE);
      }
      if (this.matches(v)) {
        this.counts.value++;
        return new Hidden(REDACTED_VALUE);
      }
      return v;
    }
    if (typeof v === "number" || typeof v === "boolean") {
      if (keys.some(isSecretKey)) {
        this.counts.name++;
        return new Hidden(REDACTED_NAME);
      }
      if (typeof v === "number" && this.secrets.has(String(v))) {
        this.counts.value++;
        return new Hidden(REDACTED_VALUE);
      }
    }
    return v;
  }

  private walk(value: unknown, keys: string[], top: boolean): unknown {
    const v = unwrapUnsafe(value);
    if (isVaultMarker(v)) return this.leaf(v, keys, top);
    if (Array.isArray(v)) return v.map((x) => this.walk(x, keys, false));
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = this.walk(x, [...keys, k], false);
      return out;
    }
    return this.leaf(v, keys, top);
  }

  /** The printable text for one value under the key path `keys`. */
  render(value: unknown, keys: string[] = []): string {
    return stringify(this.walk(value, keys, true));
  }

  /** The footer line, or "" when nothing was redacted. */
  footer(): string {
    const c = this.counts;
    const parts: string[] = [];
    if (c.vaulted) parts.push(`${c.vaulted} vaulted`);
    if (c.name) parts.push(`${c.name} by name`);
    if (c.value) parts.push(`${c.value} by value`);
    if (c.shape) parts.push(`${c.shape} by value shape`);
    if (c.url) parts.push(`${c.url} URL password${c.url === 1 ? "" : "s"}`);
    return parts.length ? `redacted: ${parts.join(", ")}` : "";
  }
}

/**
 * One value printed on its own under one key, outside any document pass (a
 * module or role option's documented default): layers 1, 3 and 4. Layer 2 needs
 * a document, so a caller that has one should `learn()` the value into its own
 * Redactor instead.
 */
export function redactStandalone(value: unknown, key: string): string {
  const red = new Redactor();
  red.learn(value, [key]);
  return red.render(value, [key]);
}

/** Compact JSON with Hidden leaves printed bare (top level) or as strings (nested). */
function stringify(v: unknown): string {
  if (v instanceof Hidden) return v.text;
  return JSON.stringify(v, (_k, x) => (x instanceof Hidden ? x.text : x)) ?? "null";
}

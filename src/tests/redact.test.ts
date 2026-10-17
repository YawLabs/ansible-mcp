import { describe, expect, it } from "vitest";
import { isSecretKey, maskUrlPasswords, Redactor, redactStandalone, redactText, unwrapUnsafe } from "../redact.js";

describe("redaction layers (design.md section 5)", () => {
  it("knows Ansible's secret names and keeps metadata visible", () => {
    for (const k of [
      "ansible_become_password",
      "ansible_become_pass",
      "ansible_ssh_pass",
      "ansible_password",
      "ansible_winrm_password",
      "ansible_httpapi_password",
      "vault_db_password",
      "vault_api",
      "api_token",
      "aws_secret_access_key",
      "tls_key_passphrase",
    ]) {
      expect(isSecretKey(k), k).toBe(true);
    }
    for (const k of [
      "vault_addr",
      "vault_url",
      "private_key_file",
      "token_ttl",
      "ansible_host",
      "ansible_user",
      "password_length",
      "become",
    ]) {
      expect(isSecretKey(k), k).toBe(false);
    }
  });

  it("hides vault markers and vault text, unwraps unsafe values", () => {
    const red = new Redactor();
    expect(red.render({ __ansible_vault: "$ANSIBLE_VAULT;1.1;AES256\n3031" })).toBe("<vaulted>");
    expect(red.render("$ANSIBLE_VAULT;1.1;AES256\n3031")).toBe("<vaulted>");
    expect(unwrapUnsafe({ a: { __ansible_unsafe: "x" } })).toEqual({ a: "x" });
    expect(red.render({ __ansible_unsafe: "plain" }, ["k"])).toBe('"plain"');
  });

  it("catches a secret copied under an innocent name (layer 2)", () => {
    const red = new Redactor();
    red.learn("FIXTURE-plain-copied-secret", ["db_password"]);
    expect(red.render("FIXTURE-plain-copied-secret", ["note"])).toBe("(redacted: contains a secret value)");
    expect(red.render("prefix FIXTURE-plain-copied-secret suffix", ["note"])).toBe(
      "(redacted: contains a secret value)",
    );
    expect(red.footer()).toBe("redacted: 2 by value");
  });

  it("prints a plain template reference as-is but redacts templates with literals", () => {
    const red = new Redactor();
    expect(red.render("{{ vault_db_password }}", ["db_password"])).toBe(
      '"{{ vault_db_password }}" (template, not rendered)',
    );
    expect(red.render("{{ 'hunter2' | b64encode }}", ["db_password"])).toBe("(redacted: secret-like name)");
  });

  it("masks URL userinfo and inline credentials in place (layer 4)", () => {
    expect(maskUrlPasswords("smtp://mailer:pw@mail.example.com:587")).toBe(
      "smtp://mailer:(redacted)@mail.example.com:587",
    );
    const red = new Redactor();
    expect(red.render("db=x password=hunter2 host=y", ["dsn"])).toBe('"db=x password=(redacted) host=y"');
    expect(red.render("ghp_FIXTUREplainGithubToken000000000004", ["note"])).toBe("(redacted: secret-like value)");
    expect(redactText("value of x must be one of: a, got: ghp_FIXTUREplainGithubToken000000000004")).not.toContain(
      "ghp_",
    );
    expect(redactText("$ANSIBLE_VAULT;1.1;AES256 3031")).toBe("<vaulted>");
  });

  it("redacts nested values under secret-like ancestors", () => {
    const red = new Redactor();
    expect(red.render({ user: "u", password: "p1234" }, ["creds"])).toBe(
      '{"user":"(redacted: secret-like name)","password":"(redacted: secret-like name)"}',
    );
    expect(red.render([1, 2], ["ports"])).toBe("[1,2]");
  });

  it("learns the passwords layer 4 masks in place, so a copy under an innocent key is caught", () => {
    const red = new Redactor();
    const doc = { db_url: "postgres://u:secretpw1234@h/db", note: "secretpw1234" };
    red.learn(doc);
    const out = red.render(doc);
    expect(out).not.toContain("secretpw1234");
    // A string that IS exactly a known secret is hidden whole, even when it is
    // also URL-shaped: the exact-match check must precede the in-place masks.
    const url = new Redactor();
    url.learn({ db_password: "https://u:pw@h/x" });
    expect(url.render("https://u:pw@h/x", ["note"])).toBe("(redacted: contains a secret value)");
  });

  it("still applies layer 2 after an in-place mask (a learned secret elsewhere in the string)", () => {
    const red = new Redactor();
    red.learn({ api_token: "learnedSecret0042" });
    expect(red.render("https://u:pw@h/learnedSecret0042", ["note"])).toBe("(redacted: contains a secret value)");
    expect(red.render("password=x path learnedSecret0042", ["note"])).toBe("(redacted: contains a secret value)");
    // Without a learned secret in it, the masked string still prints.
    expect(red.render("https://u:pw@h/plain", ["note"])).toBe('"https://u:(redacted)@h/plain"');
  });

  it("masks a URL password with an empty username (redis://:pw@host)", () => {
    expect(maskUrlPasswords("redis://:s3cret@cache.example.com:6379/0")).toBe(
      "redis://:(redacted)@cache.example.com:6379/0",
    );
    const red = new Redactor();
    const doc = { cache_url: "redis://:s3cretpw99@h", note: "s3cretpw99" };
    red.learn(doc);
    expect(red.render(doc)).not.toContain("s3cretpw99");
  });

  it("redactStandalone applies layers 1, 3 and 4 to one documented default", () => {
    expect(redactStandalone("ghp_FIXTUREplainGithubToken000000000004", "note")).toBe("(redacted: secret-like value)");
    expect(redactStandalone("hunter22", "api_token")).toBe("(redacted: secret-like name)");
    expect(redactStandalone({ __ansible_vault: "x" }, "x")).toBe("<vaulted>");
    expect(redactStandalone("self_signed", "tls_mode")).toBe('"self_signed"');
    expect(redactStandalone(["a", 1], "pkgs")).toBe('["a",1]');
  });
});

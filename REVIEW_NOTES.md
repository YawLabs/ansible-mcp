# Review notes (pre-publish adversarial review, 2026-10-15)

The build workflow's review + fix phase never ran: all four reviewers and the
fix agent hit the weekly model limit at 12:51 and returned nothing, so the
package was left built-and-green but un-reviewed. This pass re-ran the four
reviews (correctness, security, `ansible_upgrade_impact`, repo/packaging)
against the code and fixed what was substantiated. Every code fix has a
regression test.

## Fixed -- security / redaction

- **upgrade.ts (`diffOptions`): task option values echoed unredacted (high).**
  The `X no longer accepted` (line ~140) and `value ... does not convert`
  (~155) messages printed the task's literal value with no `no_log` /
  secret-key / secret-shape guard, contradicting design.md section 5 (the same
  rule `ansible_check_task_args` already enforced via its `sensitive()`).
  A secret-shaped literal that left a target `choices` list, or any value of a
  `no_log` option, printed in the clear. Fixed by adding the same `sensitive()`
  rule in upgrade.ts and using `a value` in both messages. Test: `upgrade.test.ts`
  "never echoes a secret-shaped or no_log task value".
- **upgrade.ts (`runUpgrade`): `playbooks` skipped the `-` argv guard (high).**
  Every other path parameter goes through `assertRelative`, which calls
  `refuseDash`; the `playbooks` loop called only `ctx.runner.assertLocal` (UNC
  check, no dash check). A value like `--vault-password-file=/tmp/x.sh` reached
  `ansible-playbook ["--syntax-check", pb]` and made Ansible run the named
  vault-password script, breaking the "a configured vault password script never
  runs" contract. Fixed with the same dash refusal. This is option injection,
  not just a bad path.
- **redact.ts (`Redactor.learn`): passwords layer 4 masks in place were not
  learned (medium).** Layer 2 (value equality) only registered strings hidden by
  layers 1/3/shape. A password inside `postgres://u:pw@h/db` was masked in the
  URL but not added to the secret set, so a verbatim copy under a later benign
  key printed in the clear. Added `maskedSecretValues()` (extracts URL-userinfo
  and inline-credential passwords) and `learn()` now registers them. The
  in-place mask is applied before the layer-2 match so a URL does not blanket-
  redact merely for containing its own password. Test: `redact.test.ts`.
- **config.ts (`renderConfigValue`): secret-shaped config values under a
  non-secret name were not shape-redacted (low).** Added the layer-4 shape check
  before the in-place masks, matching the inventory path.

## Fixed -- correctness

- **upgrade.ts: `!vault` task values reported as type errors (low).**
  A `` `!vault` `` value is `{__ansible_vault: ...}`; `checkValue` ran the type
  check before any vault guard, so a valid encrypted `bool`/`int` printed
  `expected bool, got a mapping`. `checkArgs.ts` now skips vault markers (the
  type is only known after decryption). Test: `checkArgs.test.ts`.
- **yaml.ts: `<<:` merge keys were not expanded (low-medium).** The reader
  treated `<<` as an ordinary symbol key and dropped the aliased mapping, so a
  task using a merge lost every merged option and the required/type checks ran
  on an incomplete argument set. Ansible (PyYAML) expands merges, own keys
  winning. Added merge resolution via the `yaml` Alias `resolve()`. Test:
  `parsers.test.ts` "expands `<<:` merge keys".
- **constraints.ts: prerelease ordering and `*` (low).** `comparePre` compared
  non-numeric segments lexically, so `rc10` sorted before `rc2`
  (`packaging`, which galaxy uses, compares the numeric run). Added
  `comparePrePart` with numeric-run comparison. Also, `satisfies` short-circuited
  every prerelease against a constraint with no version bound, so
  `satisfies("2.0.0rc1", "*")` was false; a `*`-only constraint now excludes
  nothing. Tests: `parsers.test.ts` "version constraints".

## Deferred (documented, not fixed)

- **`server.json` has no `repository.id` (high at publish time).** `release.sh`
  step 7 (`mcp-publisher publish`) validates the `io.github.YawLabs/*` namespace
  against the GitHub repo's numeric id. It cannot be added until the repo exists.
  CLAUDE.md already documents this as a pre-first-`release.sh` step ("add
  `repository.id` to server.json once the GitHub repo exists"); unchanged.
- **`package.json` `"private": true` (med at publish time).** Documented in
  CLAUDE.md as "remove it before the first publish". `release.sh` does not strip
  or gate it, so the first `release.sh` would fail late at `npm publish`. Left as
  documented (matches the sibling's flow; a script gate is a house-wide change).
- **`ansible --version` / `ansible-lint --version` probes run without
  `safetyEnv` (low, contract deviation).** Only `ansible-config dump` is exempt
  by the contract, but the version probes use `quietEnv`. In ansible-core a
  `--version` run performs no vault operation, so a configured vault-password
  script is not invoked; I could not exercise a WSL ansible here to prove it, so
  this stays a documented deviation rather than a behavior change.
- **`ansible_check_task_args` key=value (`parse_kv`) form carries no YAML node
  (low).** YAML-1.1 hints (unquoted `off`, octal `0755`) and the mode check are
  skipped for kv-form tasks because `parseKv` returns plain strings with no node.
  Threading the node through the kv parser is a larger change than this pass.
- **`collections.ts` path-separator assumption (unverified).** The shadowing
  rank and the site-packages check use `/`-separated patterns; if
  `ansible-galaxy collection list` ever emits native Windows separators the
  classification would be wrong. The native/prefixed split suggests it never
  fires; flagged, not fixed.
- **Banner fix in caddy-mcp / ssh-mcp.** Out of this repo's scope (caddy-mcp has
  an unrelated uncommitted `vitest.config.ts`). Both have the same loose oam
  probe ported here and in terraform-cwd-mcp; follow-up.

## Checks

Run in `ansible-mcp` after the fixes: `npm run lint:fix` (no fixes),
`npm run typecheck` (clean, oam 0.19.0), `npm test` (120 passed, 19 skipped in 9
files; the skips are the bash-fake launcher cases and the real-Ansible
integration suite that needs WSL collections), `npm run build` (OK),
`npm run check:compliance` (grade A, score 100, 45/45; the oversized-input
grader warning remains, as in the sibling). package.json keeps `"private": true`.
The package stays private; nothing was committed and no GitHub repo was created.

## Self-review of this pass's merge fix (follow-up)

Re-reading `src/yaml.ts` after the merge fix caught two bugs the fix itself
introduced, both now fixed with tests: a self-referential merge
(`a: &a {<<: *a}`) recursed until the stack overflowed, and a merge anchor was
converted once per use, so its duplicate keys were reported more than once. A
`WeakMap` conversion cache plus an in-progress guard covers both; chained merges
(`b: {<<: *a}`, `t: {<<: *b}`) still expand fully. Tests: `parsers.test.ts`
"follows a chained merge and survives a self-referential one" and "reports a
merge anchor's duplicate key once".

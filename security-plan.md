# Aperio Security Remediation Plan

Derived from `audit.md` + `security-eval.md` (first pass + Fable 5 addendum).
Threat model: **local now, LAN/hosted later** — agent-exfiltration surface first,
network layer built deliberately for safe future exposure.

## Operating rules

- **Verify gate (per finding):** before writing code, read the current code at the
  cited path, confirm the issue still exists, fix line refs, and drop/downgrade
  anything already resolved. Findings target ~v0.56; the tree has moved.
- **Test-first where a repro exists:** turn each finding's acceptance criteria into a
  failing test, then make it pass.
- **Surgical diffs:** one finding = one focused change + tests. No drive-by refactors.
- **Reuse existing machinery:** extend the confirm-token flow (`lib/agent/tool-hooks.js`)
  and WS confirm events; do not reinvent.

Status legend: ☐ todo · ◐ in progress · ☑ done · ⊘ dropped (already fixed / N/A)

---

## Phase 0 — Agent exfiltration surface (do first)

Coupled: SHELL-01 + INJECT-01 land together (SHELL-01 closes the curl/interpreter holes
that make INJECT-01 catastrophic).

- ☑ **EGRESS-01** — `lib/helpers/ssrfGuard.js` (`assertPublicUrl` + `isBlockedAddress`,
  opt-outs `APERIO_ALLOW_INTERNAL_FETCH` / `APERIO_EGRESS_ALLOWLIST`) + `lib/helpers/egressLog.js`,
  wired into `fetch_url` (web.js) and `fetchImageAsBase64` (github.js). Tests:
  `tests/lib/helpers/ssrfGuard.test.js` + web.test.js integration case. 131/131 tool tests pass.
  - ⊘ **SSRF-02 dropped** — current `describeImageHandler` takes only `path`/`data` (no `url`
    param); it never fetches an external URL, so there's nothing to guard there.
- ☑ **SHELL-01** — `validateSegmentArgs` in shell.js: rejects node/python inline-eval
  (`-e`/`--eval`/`-p`/`--print`/`-pe`/`-c`/`-`), `find -exec/-execdir/-ok/-delete`, `git -c`
  + non-read-only git subcommands; `curl` removed from `ALLOWED_CMDS`; node/python script
  args and `cat/grep/rg/head/tail/wc` file args confined to the allowlist (quote-aware
  tokenizer; relative args resolved against the pinned cwd). Tool description + README +
  .env.example now state "not a sandbox". Tests: 15 cases in shell.test.js. 372/372 pass.
  - ⚠️ **Residual:** `npm` left allowlisted (lifecycle/install hooks run package code) —
    needed for legit dependency installs; addendum didn't list it. Revisit if npm proves
    an exploit path.
- ☑ **INJECT-01** — fencing + taint infra (below); tainted-write enforcement landed in WRITE-01.
  - ☑ Provenance fencing in `callToolHooked` (tool-hooks.js): output of `fetch_url`,
    `fetch_github_issue`, `read_file`, `read_docx`, `scan_project` wrapped in
    `--- UNTRUSTED EXTERNAL CONTENT … ---` (handles string + text/image block shapes; errors unfenced).
  - ☑ Per-turn `taint` flag set on untrusted reads, exposed from `makeTurnHooks` for the write/egress gate.
  - ☑ `fetch_github_issue` `include_images` default → false (handler + schema + description).
  - ☑ System-prompt rule in `id/whoami.md` ("Untrusted Tool Content"). Tests: 5 cases in
    tool-hooks.test.js. Full suite 1613/1613.
  - ⤳ **Re-sequenced:** the "tainted `write_file`/`edit_file`/`append_file` raises a confirm
    rather than executing" acceptance criterion needs the tool-level confirm-stash that **WRITE-01**
    builds (the confirm round-trip replays via the MCP tool's `confirmation_token`, which write
    tools don't support yet). WRITE-01 will consume `hooks.taint`. Realistic egress
    (`create_github_issue`) already always-confirms, so tainted egress is already gated.
- ☑ **WRITE-01** — `write_file`/`edit_file`/`append_file` now use delete_file's two-phase
  confirm-stash (`wr_` token, `pendingWrites` map in files.js). Gate policy: confirm when the
  write lands **outside `/var/scratch/`** OR the turn is **tainted** (`__tainted` injected by the
  tool-hook from `hooks.taint`); new/overwrite inside scratch in a clean turn executes directly
  (frictionless skill output). edit_file confirm shows a capped unified diff. Wired into
  `CONFIRM_TOOLS` (tool-profiles.js), `CONFIRMABLE_TOOLS` + token regex (wsHandler.js), token
  detection + post-write-validation skip (tool-hooks.js). Schemas got `.passthrough()` so
  `__tainted` survives the MCP boundary. Tests: 6 gate cases (files.test.js) + 3 wiring cases
  (tool-hooks.test.js); existing mechanics tests routed through a two-phase `confirmed()` helper.
  Full suite 1622/1622.
  - ✅ **Closes INJECT-01 enforcement:** a tainted turn now routes write/edit/append through the
    confirm event rather than executing — the acceptance criterion deferred from INJECT-01.

## Phase 1 — Quick wins

- ☐ **SECRET-01** — `.env` `0600`; fix `envFile.js` escaping (strip newlines, escape `\`, always quote).
- ☐ **ENV-01 / SECRET-02** — stop loading `.env.example` as live config; hard-fail on default
  `POSTGRES_PASSWORD`; add `:?` guard to `docker-compose.prod.yml`.
- ☐ **PATH-01** — `~` expansion via `os.homedir()`.
- ☐ **INJECTION-01** — regex guard on table names + "no `${name}` without whitelist" test.
- ☐ **INPUT-01** — remove dead `.env.example` ext entry; dotfile/secret deny-list before ext allowlist.
- ☐ **DOS-01** — global JSON limit → 256kb.
- ☐ **NET-02** — `helmet` (verify CSP allows current inline scripts first).

## Phase 2 — Network layer (build now; LAN on roadmap)

- ☐ **REBIND-01** — Host-header allowlist + Origin check + `X-Aperio-Client` header on
  state-changing `/api`; update frontend fetch wrapper. *(do first — protects local mode too)*
- ☐ **AUTH-01** — opt-in `APERIO_AUTH_TOKEN` middleware on `/api/*` + WS `verifyClient`.
- ☐ **PRIVACY-01** — `local_only` memory flag excluded from cloud preloads; `redactSecrets.js`
  before provider calls; gate `infer`/`deduplicate` workers for non-local providers.
- ☐ **DATA-01** — `0600` + redaction across `var/logs`, `var/handoffs`, `var/sessions`;
  fix handoff-location comment bug.
- ☐ **NET-03** — `express-rate-limit` on setup/import/embedding/indexing routes.
- ☐ **PATH-02** — session-token check on `/uploads` and `/scratch` static mounts.

## Phase 3 — Deferred until hosting

- ☐ **SECRET-01 (keychain)** — OS keychain for API keys.
- ☐ **NET-01** — built-in TLS via `https.createServer`.
- ☐ **SESSION-01** — at-rest session encryption.
- ☐ **DEP-02** — remove `--no-audit`; `npm audit` + Dependabot in CI.
- ☐ **PROC-01** — uncaught-exception circuit breaker.
- ☐ **LOG-01** — prod error handler with scrubbed client messages.
- ☐ **Doc drift (audit.md §5)** — reconcile `SECURITY.md`/`README` version + threat-model wording.

---

## Sequencing

```
Phase 0 ─► Phase 1 ─► Phase 2 (REBIND first) ─► Phase 3
EGRESS→SHELL+INJECT→WRITE
```

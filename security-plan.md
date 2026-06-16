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

- ☑ **SECRET-01** — `envFile.js`: new `envQuote` (strips newlines/control chars so a value
  can't inject extra `KEY=` lines, escapes `\` then `"`, always quotes) + `setKey` now uses
  function replacers (so `$` in a value isn't read as a backreference — latent bug fixed).
  `.env` written `0600` via new `writeEnv` helper (chmod after write, since `writeFileSync`
  mode is ignored on an existing file). `setKey`/`envQuote` exported for test.
  Tests: `tests/lib/helpers/envFile.test.js` (11 cases incl. newline-injection).
- ☑ **ENV-01 / SECRET-02** — server.js no longer falls back to `.env.example` as live config
  (only loads a real `.env`; pre-setup relies on process env + in-code `??` defaults).
  `db/postgres.js` `assertNonDefaultDbUrl` hard-fails when `DATABASE_URL` carries the example
  default password (`:aperio_secret@`), opt-out `APERIO_ALLOW_DEFAULT_DB_PASSWORD=1`; called in
  `PostgresStore.init`. Tests: `tests/db/postgres-guard.test.js` (4 cases).
  - ⊘ **`:?` guard already present** — `docker/docker-compose.yml` + `.prod.yml` both already
    `${POSTGRES_PASSWORD:?…}`.
- ◐ **PATH-01** — was already expanded via `os.homedir()` across paths.js / api-codegraph /
  api-docgraph. Hardened + DRY'd: new exported `expandTilde` in paths.js (regex `^~(?=\/|$)` so
  `~user/…` is left intact instead of mangled to `<home>user/…`), used in the 4 paths.js sites.
  api-codegraph/docgraph left as-is (correct for the common `~/` case — not touched, surgical).
  Tests: `tests/lib/routes/paths.test.js` (5 cases).
- ☑ **INJECTION-01** — enforcement **already existed**: `db/tables.js` `isAllowedTable`
  (Set whitelist, stronger than a regex) gates `readTable(name)` in both stores; the only other
  `${name}` interpolation (`listTables`) iterates the constant `DB_TABLES`. Added the missing
  regression test: `tests/db/tables.test.js` (rejects injection payloads / internal tables /
  empty input, accepts every advertised table).
- ☑ **INPUT-01** — removed dead `.env.example` ext entry (mcp/tools/files.js `ALLOWED_EXTENSIONS`
  + attachments `TEXT_EXTS`; `extname` never yields `.env.example` so it was unreachable). Added a
  secret/dotfile deny-list checked **before** the ext allowlist: `.env*`, known credential
  basenames (`.pgpass`/`.npmrc`/`id_rsa`/…), cert exts (`.pem`/`.key`/…). Wired into `read_file`
  + `edit_file` (edit reads first → leak vector) and the attachment router. Tests: 6 cases in
  files.test.js (`.env`, `.pgpass`, `id_rsa`, `.pem`, `.env.example` now unreadable, edit refusal).
- ☑ **DOS-01** — global `express.json` limit `1mb` → `256kb` (server.js). Per-route limits
  (memories import 512kb, etc.) unchanged — intentional overrides.
- ☑ **NET-02** — `helmet` added (`contentSecurityPolicy: false`). CSP stays off for now: the UI
  relies on inline `<script>`/`onclick=`/`style=` + jsdelivr/Google-Fonts CDNs, so a strict policy
  needs those reworked first (deferred). All other helmet headers active (nosniff, frameguard,
  Referrer-Policy, …). Full suite 1650/1650.

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

## Testing

How to verify the **completed** phases (0 and 1). Phases 2–3 will get their own
subsections as they land. Every finding has automated coverage; a few also have a
manual check for things the suite can't assert (file perms, live HTTP headers).

**Run everything:**

```bash
npm test                      # full suite, human-readable output
APERIO_AGENT_RUN=1 npm test   # quiet reporter (summary only) — same pass/fail
```

Run one file in isolation: `NODE_ENV=test node --test tests/<path>.test.js`.
Baseline after Phase 1: **1650/1650 passing**.

### Phase 0 — agent exfiltration surface

| Finding | Automated | Manual sanity check |
|---|---|---|
| **EGRESS-01** (SSRF) | `tests/lib/helpers/ssrfGuard.test.js` + integration case in `tests/mcp/tools/web.test.js` | ask the agent to `fetch_url http://169.254.169.254/` or `http://localhost` → blocked with an SSRF-guard message (unless `APERIO_ALLOW_INTERNAL_FETCH=1`). |
| **SHELL-01** (shell allowlist) | `tests/mcp/tools/shell.test.js` (15 cases) | `run_shell node -e "..."`, `find … -exec`, `git -c …`, or `curl …` → all refused. |
| **INJECT-01** (prompt-injection fencing/taint) | `tests/lib/agent/tool-hooks.test.js` (5 cases) | after a `fetch_url`/`read_file`, the content is wrapped in `--- UNTRUSTED EXTERNAL CONTENT … ---` and that turn's writes raise a confirm (see WRITE-01). |
| **WRITE-01** (confirm-on-write gate) | `tests/mcp/tools/files.test.js` (6 gate cases) + `tool-hooks.test.js` (3 wiring) | write outside `/var/scratch/` → confirm prompt; write a new file *inside* scratch in a clean turn → executes directly. |

### Phase 1 — quick wins

| Finding | Automated | Manual sanity check |
|---|---|---|
| **SECRET-01** (.env escaping + 0600) | `tests/lib/helpers/envFile.test.js` (11 cases incl. newline-injection, `$`-safety, always-quote) | after setup writes `.env`: `ls -l .env` → `-rw-------` (0600). |
| **ENV-01** (no `.env.example` as live config) | covered indirectly; no unit test (boot-path) | rename/remove `.env`, start the server → setup wizard appears and `aperio_secret` is **not** active in `process.env`. |
| **SECRET-02** (default DB password hard-fail) | `tests/db/postgres-guard.test.js` (4 cases) | set `DATABASE_URL=postgresql://aperio:aperio_secret@localhost/aperio` and start → boot fails with "default Postgres password"; `APERIO_ALLOW_DEFAULT_DB_PASSWORD=1` overrides. |
| **PATH-01** (`~` expansion) | `tests/lib/routes/paths.test.js` (5 cases) | — |
| **INJECTION-01** (table-name whitelist) | `tests/db/tables.test.js` (injection payloads / internal tables / empties rejected) | DB browser only lists the whitelisted tables; an out-of-list name throws "Unknown table". |
| **INPUT-01** (secret deny-list) | 6 cases in `tests/mcp/tools/files.test.js` (`secret-file deny-list` describe) | ask the agent to `read_file ./.env` or attach `id_rsa`/`server.pem` → refused before any extension check. |
| **DOS-01** (256kb JSON cap) | — | `curl -X POST http://127.0.0.1:3000/api/<json-route> -H 'content-type: application/json' --data-binary @big.json` (>256kb) → `413 Payload Too Large`. |
| **NET-02** (helmet headers) | — | `curl -sI http://127.0.0.1:3000/ \| grep -iE 'x-content-type-options\|x-frame-options\|referrer-policy'` → present; **no** `content-security-policy` (CSP deliberately off). |

---

## Sequencing

```
Phase 0 ─► Phase 1 ─► Phase 2 (REBIND first) ─► Phase 3
EGRESS→SHELL+INJECT→WRITE
```

# Plan: Configure Aperio from the Web UI (minimal `.env`)

> **Goal.** Non-code users should never open `.env`. Keep a tiny `.env.example`
> that only holds true bootstrap plumbing; give **every other** variable a typed
> control in the Settings UI (toggle / checkbox / select / number / text /
> secret), backed by the database. Developers can still set anything via `.env`.
>
> This is a living plan used across multiple prompts/phases. Phases are
> independent and shippable. Check off items as they land.

---

## 1. Where we are today (3 config surfaces)

1. **`.env` / `.env.example`** — ~59 variables, read **directly** via
   `process.env.*` in ~12 files (`lib/providers/index.js`, `lib/agent/providers/*`,
   `lib/workers/roundtable.js`, `server.js`, `db/*`, …). There is **no central
   config layer** — this is the main obstacle.
2. **`localStorage`** — device-local UI prefs (theme, tts, language, sidebar
   state), mirrored to the DB by `public/scripts/settings.js` (local-first,
   write-through, boot reconcile).
3. **DB `settings` table** — key/value store. Already the source of truth for
   `triage.*`, `allowed-paths`, `aperio-busy-words`, `aperio-tts`, etc.

### Plumbing we can reuse (don't rebuild)

| Piece | Location | Notes |
|---|---|---|
| `store.getSetting/setSetting/getSettings/deleteSetting` | `db/sqlite.js`, `db/postgres.js` | DB key/value CRUD |
| `/api/settings` CRUD + secret masking | `lib/routes/api-settings.js` | `SECRET_SETTING_KEYS` returns `{configured:bool}`, never echoes secrets |
| `persistEnvVar(key, value)` | `lib/helpers/envFile.js` | Writes a single `KEY=...` into `.env` (already used for `APERIO_AGENT_JOBS`). Seeds from `.env.example`. Quotes/escapes safely. |
| `writeEnvFromWizard(...)` | `lib/helpers/envFile.js` | First-run wizard → writes `.env` |
| Settings drawer | `public/scripts/settings-panel.js` | Slide-in panel; already hosts model picker, sound, busy words |
| Local-first sync | `public/scripts/settings.js` | `get/set/register/init` against `/api/settings` |
| DB-over-env precedent | `lib/routes/api-github-webhook.js`, `triage.*` | DB value wins over env var; env kept for headless deploys |

---

## 2. The core gap

To make the UI authoritative we need **one read path** that resolves a setting as:

```
DB setting (if present)  >  process.env.<VAR>  >  built-in default
```

Today each of the ~59 vars is read inline (`process.env.FOO ?? default`) in
scattered files. We introduce a **config registry + resolver** so every read
goes through one place, the UI can drive it, and `.env` becomes optional.

This is the load-bearing change. Everything else is wiring on top of it.

---

## 3. Tier classification (decides what stays in `.env`)

### Tier 0 — Bootstrap-only → **stays in minimal `.env.example`**
Read **before the DB exists**, or they *configure the DB / network identity
itself*, so they cannot live in a DB-backed UI. Also the riskiest to expose in a
browser form. The first-run wizard already writes most of these.

`AI_PROVIDER` (initial pick), `PORT`, `HOST`, `DB_BACKEND`, `SQLITE_PATH`,
`DATABASE_URL`, `POSTGRES_HOST/PORT/DB/USER/PASSWORD`, `APERIO_DB_ENCRYPT`,
`APERIO_SESSION_KEY`, `APERIO_TLS_CERT`, `APERIO_TLS_KEY`, `APERIO_AUTH_TOKEN`,
`APERIO_ALLOWED_HOSTS`.

> Security stance: these are shown in the UI **read-only** (status: set / not set)
> with a "edit in `.env` — restart required" note. We do **not** accept new auth
> tokens / TLS paths / DB creds through a web form that might itself be exposed.

### Tier 1 — Hot-reloadable → **moves fully into the UI** (DB-backed)
Behavior toggles and model/runtime knobs that can take effect without a restart
once reads go through the resolver and the cache invalidates on write.

Provider keys + models (`ANTHROPIC_*`, `DEEPSEEK_*`, `GEMINI_*`, `OLLAMA_MODEL`,
`VOYAGE_API_KEY`), Ollama extras (`OLLAMA_BASE_URL/HOST/VLM_MODEL/NUM_CTX`,
`CHECK_RAM`), `GEMINI_THINKING_BUDGET`, roundtable (`ROUNDTABLE_*`), wiki refresh
(`WIKI_REFRESH_PROVIDER`, `WIKI_REFRESH_AUTOSTART_OLLAMA`), tools
(`APERIO_ENABLE_SHELL`, `APERIO_SHELL_LOCAL`, `APERIO_CAPABLE_MODELS`,
`APERIO_CODEGRAPH`, `APERIO_DOCGRAPH`), agents (`APERIO_AGENT_JOBS` — already),
GitHub (`GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET` — already), workers
(`APERIO_CLOUD_MEMORY_WORKERS`), retention/timeouts (`IDLE_TIMEOUT_SECONDS`,
`HEARTBEAT_INTERVAL_SECONDS`, `SESSION_RETENTION_DAYS`,
`AGENT_RUN_RETENTION_DAYS`, `*_FETCH_TIMEOUT_MS`, `OLLAMA_HEALTH_TIMEOUT_MS`),
diagnostics (`APERIO_LOG_RETENTION`, `DEBUG`), allowed paths (already DB).

### Tier 2 — DB-backed but **needs restart / reindex** (UI shows a banner)
`EMBEDDING_PROVIDER`, `EMBEDDING_DIMS`, `TRANSFORMERS_CACHE` (changing dims/
provider requires a fresh vector index), and surfacing `DB_BACKEND` as a
read-only "current backend" with a guided-migration note.

> Full per-variable mapping lives in **§8 Registry**.

---

## 4. Resolution precedence & hot reload

- New helper `lib/config.js`:
  - `config.get(key)` → DB value → `process.env` → default (from registry).
  - In-memory cache; `config.invalidate(key)` on every `PUT /api/settings/:key`.
  - Typed coercion per registry (`bool`, `int`, `csv`, `string`, `secret`).
- Migrate the ~59 inline `process.env.*` reads to `config.get(...)`
  **incrementally, one section per phase** (§7). Until a read is migrated, the
  env var still works — no big-bang cutover.
- Some Tier 1 values are captured once at startup (e.g. log retention, embeddings
  fingerprint). For those, write-through still updates the DB + `.env`
  (via `persistEnvVar`) so the next start is correct, and the UI labels them
  "applies on next restart". Truly live ones (provider/model switch, toggles
  checked per-request) reflect immediately.

---

## 5. Single source of truth + on-demand sync

The **registry** (`lib/config.js`) — not the `.env` files — is the source of
truth. Each entry carries everything a typed UI control and a doc line need:
`key, envVar, type, tier, section, label, help, default, options?, secret?`.

### `.env.example` is *generated* from the registry
A small script (`npm run config:gen-example`) renders `.env.example` from the
registry, grouped by section, with each entry's help text as the comment.
Consequences:
- **Adding a variable = one edit** (a registry entry). The UI control **and** the
  `.env.example` line appear together, in sync, by construction — they cannot
  drift.
- A CI guard (`npm run config:check` → diff-or-fail) keeps a hand-edited
  `.env.example` from drifting out of sync with the registry, the same way
  generated files are guarded elsewhere.

### What "reflect" means at runtime
| Action | Result |
|---|---|
| Edit a *value* of a known var in `.env` | Takes effect on **restart** (dotenv reads at boot). And if a UI/DB value exists for that key, **the DB value wins** (precedence §4) and the `.env` edit is ignored — the UI shows an *"overridden by `.env`"* / *"overridden in Settings"* badge so this is never silent. |
| Add a var **to the registry** | UI control **and** `.env.example` line both appear, in sync. |
| Add a var **to `.env` only** (no registry entry) | Works at runtime, but has no typed control — it surfaces only via on-demand sync below. |

### On-demand sync (the "where does a new var land?" answer)
Because a raw var added to `.env`/`.env.example` has no `section`, we don't guess
silently. Instead, **sync is explicit** and always gives the var a home:

- **Trigger:** a "Sync from `.env`" button in the drawer's **Advanced** area, and
  a CLI `npm run config:sync`. (Not automatic — a deliberate action, so a stray
  var never reshapes the UI behind the user's back.)
- **What it does:** parses `.env` **and** `.env.example` (via `dotenv.parse`),
  diffs the keys against the registry, and reports three buckets:
  1. **Managed** — in registry: nothing to do.
  2. **Unmanaged** — present in a file, missing from the registry.
  3. **Orphaned** — in the registry, absent from `.env.example` (regenerate).
- **Where unmanaged vars land:** a catch-all **"Unmanaged / Imported"** section
  (advanced, collapsed). Each gets an **inferred control** so it's editable
  immediately: `secret` if the name matches `*KEY|TOKEN|SECRET|PASSWORD*`,
  `toggle` for `on/off/true/false/1/0`, `number` for numeric, else `text`. So a
  new var *always* has a place in the UI even before anyone refines it.
- **Promote, don't lose:** `config:sync --scaffold` writes a draft registry stub
  (inferred type + a TODO `section/label/help`) for each unmanaged var. A
  developer edits the section/label and the control moves from "Unmanaged" into
  its proper place; nothing is required from the non-code user.

> So the lifecycle is: raw var in `.env` → **Sync** → editable under
> "Unmanaged / Imported" → (optional) `--scaffold` + a dev edit → promoted to a
> real section. Non-coders never see a half-configured var with no home.

---

## 6. UI design

### Control types
| Type | Used for | Example vars |
|---|---|---|
| `toggle` | on/off booleans | `APERIO_ENABLE_SHELL`, `APERIO_CODEGRAPH`, `CHECK_RAM`, `DEBUG`, agent jobs |
| `select` | enums | `AI_PROVIDER`, `EMBEDDING_PROVIDER`, `APERIO_LOG_RETENTION` |
| `number` | numeric | ports, `*_TIMEOUT_MS`, `OLLAMA_NUM_CTX`, retention days, thinking budget |
| `text` | free string | model ids, `OLLAMA_BASE_URL`, `ROUNDTABLE_AGENTS` |
| `list` | comma/line lists w/ add-remove chips | `APERIO_CAPABLE_MODELS`, allowed paths, allowed hosts |
| `secret` | write-only, masked | all API keys, `GITHUB_TOKEN`, webhook secret |

### Layout — extend the existing Settings drawer
Sections mirror the `.env.example` headings, **plain ones open, advanced
collapsed** behind a "Developer / advanced" disclosure:

1. **AI Provider & Keys** (select provider → reveal that provider's key+model)
2. **Local Models (Ollama)** — base url, vlm, num_ctx, check-ram
3. **Embeddings** *(Tier 2 banner)*
4. **Tools** — shell, capable models, codegraph, docgraph
5. **Background Agents** — jobs toggle, run retention
6. **GitHub** *(already built — fold into this scheme)*
7. **Wiki refresh** · **Round-table** *(advanced)*
8. **Memory & Workers** — cloud memory workers, allowed paths
9. **Data & Sessions** — idle/heartbeat/session retention
10. **Diagnostics** — log retention, debug
11. **Security & Network** *(read-only mirror of Tier 0 + note)*
12. **Unmanaged / Imported** *(advanced, collapsed)* — vars found in `.env` but
    not yet in the registry, surfaced by on-demand sync (§5) with an inferred
    control. Empty/hidden when everything is managed.

### Schema-driven rendering (avoid hand-coding 50 controls)
- New endpoint `GET /api/config/schema` returns the registry (key, label, help,
  type, section, tier, options, `secret`, current value or `{configured}`).
- A generic renderer builds each section from the schema; writes reuse
  `settings.js` write-through (`PUT /api/settings/:key`). Secrets use the
  existing masking — never rendered with a value, only a "Set / Replace" field +
  "configured" badge.
- Server-side: `PUT /api/settings/:key` for a registry key also calls
  `persistEnvVar` for vars whose effect is read at startup, and
  `config.invalidate` for live ones.

---

## 7. Phases

- [ ] **Phase 1 — Config registry + resolver + generator (no UI change).**
  Add `lib/config.js` + registry (§8), the resolver, **and** the `.env.example`
  generator + `config:check` guard (§5) so the registry is the single source of
  truth from day one. Route reads through `config.get` for **one** pilot section
  (Tools: shell/codegraph/docgraph). Add tests: DB-over-env precedence, type
  coercion, cache invalidation, generated `.env.example` matches the registry.
  *Verify:* existing behavior unchanged when only `.env` is set; DB value
  overrides env; `config:check` fails on a stale `.env.example`.

- [ ] **Phase 2 — Schema endpoint + generic UI renderer + on-demand sync.**
  `GET /api/config/schema`; render the pilot section in the drawer from schema;
  wire secret masking. Add the sync path (§5): `npm run config:sync`
  (+`--scaffold`) and the drawer's "Sync from `.env`" button feeding the
  **Unmanaged / Imported** section with inferred controls. *Verify:* toggling
  shell in UI flips behavior with no restart; secret never returned by GET; a var
  added to `.env` by hand shows up under "Unmanaged" after Sync.

- [ ] **Phase 3 — Migrate remaining Tier 1 sections** (provider/keys, Ollama,
  agents, workers, retention/timeouts, wiki, roundtable, diagnostics), one
  section per PR, each migrating its `process.env` reads + adding its UI block.

- [ ] **Phase 4 — Tier 2 (restart/reindex) UX.** Embeddings + DB backend with an
  explicit "applies after restart / requires reindex" banner and a safe path
  (write DB + `.env`, prompt to restart).

- [ ] **Phase 5 — Shrink `.env.example` + docs.** Reduce to Tier 0 only (see §9),
  add a one-line "everything else → Settings" pointer, update the setup wizard
  copy, README, and `FEATURES.md`.

---

## 8. Registry (full mapping — source of truth for the schema)

Legend: **T** tier · **Ctl** control · **Sec** section (§6) · `*` already DB-backed

| Var | T | Ctl | Sec | Hot? |
|---|---|---|---|---|
| `AI_PROVIDER` | 1 | select | 1 | live (model switch) |
| `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` | 1 | secret | 1 | live |
| `ANTHROPIC_MODEL` / `DEEPSEEK_MODEL` / `GEMINI_MODEL` / `OLLAMA_MODEL` | 1 | text | 1 | live |
| `OLLAMA_BASE_URL` / `OLLAMA_HOST` | 1 | text | 2 | restart |
| `OLLAMA_VLM_MODEL` | 1 | text | 2 | live |
| `OLLAMA_NUM_CTX` | 1 | number | 2 | restart (KV cache) |
| `CHECK_RAM` | 1 | toggle | 2 | restart |
| `GEMINI_THINKING_BUDGET` | 1 | number | 1 | live |
| `EMBEDDING_PROVIDER` | 2 | select | 3 | **reindex** |
| `VOYAGE_API_KEY` / `VOYAGE_MODEL` | 1 | secret/text | 3 | live |
| `EMBEDDING_DIMS` | 2 | number | 3 | **fresh DB** |
| `TRANSFORMERS_CACHE` | 2 | text | 3 | restart |
| `APERIO_ENABLE_SHELL` / `APERIO_SHELL_LOCAL` | 1 | toggle | 4 | live |
| `APERIO_SHELL_MAX_OUTPUT_BYTES` | 1 | number | 4 | live |
| `APERIO_CAPABLE_MODELS` | 1 | list | 4 | live |
| `APERIO_CODEGRAPH` / `APERIO_DOCGRAPH` | 1 | toggle | 4 | restart (watcher) |
| `APERIO_AGENT_JOBS` `*` | 1 | toggle | 5 | live (already) |
| `AGENT_RUN_RETENTION_DAYS` | 1 | number | 5 | live |
| `GITHUB_TOKEN` `*` / `GITHUB_WEBHOOK_SECRET` `*` | 1 | secret | 6 | live (already) |
| `triage.repos` `*` | 1 | list | 6 | live (already) |
| `WIKI_REFRESH_PROVIDER` | 1 | text | 7 | live |
| `WIKI_REFRESH_AUTOSTART_OLLAMA` | 1 | toggle | 7 | live |
| `ROUNDTABLE_AGENTS` / `_CHARACTERS` | 1 | text | 7 | live |
| `ROUNDTABLE_MAX_ROUNDS` | 1 | number | 7 | live |
| `APERIO_CLOUD_MEMORY_WORKERS` | 1 | toggle | 8 | restart (workers) |
| `APERIO_ALLOWED_PATHS_TO_READ/WRITE` `*` (`allowed-paths`) | 1 | list | 8 | live (already) |
| `IDLE_TIMEOUT_SECONDS` / `HEARTBEAT_INTERVAL_SECONDS` | 1 | number | 9 | restart |
| `SESSION_RETENTION_DAYS` | 1 | number | 9 | live (GC) |
| `*_FETCH_TIMEOUT_MS` / `OLLAMA_HEALTH_TIMEOUT_MS` | 1 | number | 9 | live |
| `APERIO_LOG_RETENTION` | 1 | select | 10 | restart |
| `DEBUG` | 1 | toggle | 10 | restart |
| `APERIO_EGRESS_ALLOWLIST` / `APERIO_ALLOW_INTERNAL_FETCH` | 1 | list/toggle | 11 | restart |
| `AI_PROVIDER` (bootstrap), `PORT`, `HOST` | 0 | read-only | 11 | `.env` |
| `DB_BACKEND`, `SQLITE_PATH`, `DATABASE_URL`, `POSTGRES_*` | 0 | read-only | 11 | `.env` |
| `APERIO_DB_ENCRYPT`, `APERIO_SESSION_KEY` | 0 | read-only | 11 | `.env` |
| `APERIO_TLS_CERT/KEY`, `APERIO_AUTH_TOKEN`, `APERIO_ALLOWED_HOSTS` | 0 | read-only | 11 | `.env` |

`DOCGRAPH_CHUNK_TOKENS/OVERLAP`, `DOCGRAPH_XLSX_MAX_ROWS`,
`APERIO_ALLOW_DEFAULT_DB_PASSWORD`, `APERIO_PROVIDER_LOCAL`: leave env-only
(power-user/internal) unless asked — they don't confuse non-coders.

---

## 9. Target minimal `.env.example`

Only Tier 0, with a pointer (in practice this file is **generated** — §5):

```dotenv
# Aperio plumbing. Most people never edit this — run `npm start` and the
# in-app Settings panel handles the rest. Only DB/network/security basics
# live here because they load before the app (and the Settings UI) is up.

AI_PROVIDER=ollama          # initial pick; change later in Settings → AI Provider
PORT=31337
# HOST=127.0.0.1            # loopback only; 0.0.0.0 for LAN (understand the risk)

# Database (auto: Postgres if Docker up, else SQLite)
# DB_BACKEND=sqlite
# DATABASE_URL=postgresql://aperio:CHANGE_ME@localhost:5432/aperio

# Security (optional, advanced) — set here, not in the web UI:
# APERIO_AUTH_TOKEN=  · APERIO_TLS_CERT=  · APERIO_TLS_KEY=
# APERIO_SESSION_KEY= · APERIO_DB_ENCRYPT=1 · APERIO_ALLOWED_HOSTS=

# Everything else (models, keys, tools, agents, embeddings, retention…)
# → set it in the app: Settings panel. Stored in your database.
```

---

## 10. Open decisions (confirm before/within each phase)

1. **Precedence** — recommend **DB > env > default** (matches existing GitHub/
   triage behavior). Alternative (env wins, for locked-down deploys) could be a
   single `APERIO_CONFIG_ENV_WINS=1` escape hatch.
ME: I agree with **DB > env > default**
2. **Tier 0 in the UI** — recommend **read-only mirror** (status only), edited in
   `.env`. Don't accept new secrets/creds via a possibly-exposed web form.
ME: How the users will then provide personal access token for GitHub, aor any gemini, deepseek, anthropic api keys? is this going to restict non code users?
3. **Restart UX for Tier 2** — banner + "Restart now" button (graceful
   `IDLE_TIMEOUT` already exists) vs. just a note. Recommend a note for Phase 4,
   button later.
4. **Secrets at rest** — DB-stored API keys: rely on existing
   `APERIO_DB_ENCRYPT` / `APERIO_SESSION_KEY`, or always write secrets to `.env`
   (0600) instead of the DB? Recommend `.env` for secrets via `persistEnvVar`,
   DB for non-secret prefs — keeps keys off the DB and out of any backup.
ME: Check my answer on 2. - I think those are kind of relevant
5. **Sync auto-adopt vs. manual** — recommend **on-demand** sync (a button / CLI),
   not automatic on boot, so a stray `.env` var can't silently reshape the UI.
   Unmanaged vars are editable immediately under "Unmanaged / Imported" but only
   move to a real section when a developer scaffolds + assigns one. Alternative:
   auto-run sync at startup and just log new vars — simpler, but surprises users.
ME: Agree for when developer scaffolds, but for the moving and editing  - I'll let this to you
```
```

---

### Verification per phase
Each phase ships with: a test proving DB-over-env precedence for its vars, a
manual check that the UI control changes behavior, and (for secrets) a check that
`GET` never returns the value. `.env`-only operation must keep working
throughout (developers untouched).

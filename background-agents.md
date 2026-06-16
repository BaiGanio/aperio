# Background Agents

Standing, scheduled agents that operate on Aperio's store **without a chat turn**.
Today every agent run is triggered by a user message over WebSocket or the CLI.
Background agents add a second entry point: jobs that fire on a timer, on demand
via the API, or (later) on a watcher event — and write their results back into the
same memory / wiki / files surface that chat uses.

The chat UI stops being the only client; it becomes one of several.

> Note: this doc lives at the repo root, not under `docs/` — `docs/` is the
> published GitHub Pages site and non-site files placed there get cleaned.

---

## Why this fits the existing code

A background-agent runner is **not a new agent engine**. The pieces already exist:

| Need | Already in repo |
|------|-----------------|
| Run tools headless | `agent.callTool(name, input)` — the same dispatch chat uses |
| Run a full reasoning turn | `agent.runAgentLoop(messages, emitter, opts)` → returns final answer |
| Worker lifecycle | `createSessionPruner() → { stop }`, `setInterval().unref()` |
| Background loop precedent | `deduplicateMemories(callTool)`, `inferMemories(callTool)` |
| File-change triggers | `lib/codegraph/watcher.js`, `lib/docgraph/watcher.js` (chokidar) |
| Run transcripts to disk | `writeRoundtableRecord()` → `var/roundtables/` |

```
   triggers                 scheduler core                   outputs
 ┌────────────┐      ┌───────────────────────────┐      ┌──────────────┐
 │ interval   │─────▶│ job registry (jobs.json)   │─────▶│ store        │
 │ manual API │─────▶│ runJob() single-flight     │─────▶│ wiki / files │
 │ watcher(P3)│─────▶│   steps  → callTool        │─────▶│ var/agents/  │
 └────────────┘      │   freeform → runAgentLoop  │      │ logger       │
                     └───────────────────────────┘      └──────────────┘
```

---

## Job definition

Jobs live in the **`agent_jobs` DB table** (Phase 4 — they used to live in
`var/agents/jobs.json`, which is no longer read). The `002_agent_jobs.sql`
migration seeds the `nightly-maintenance` example, and jobs are managed through
the `/api/agents` routes below. A job's heterogeneous shape is stored as a JSON
`definition` blob; only `id` and `enabled` are promoted to columns (all the
scheduler filters on). The store re-merges them into the flat object below.

```json
{
  "id": "nightly-maintenance",
  "enabled": true,
  "trigger": { "kind": "interval", "everyMs": 86400000 },
  "steps": [
    { "tool": "backfill_embeddings", "input": {} },
    { "tool": "deduplicate_memories", "input": { "threshold": 0.97, "dry_run": true } }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `id` | Unique; names the run-record file `var/agents/aperio-agent-<id>.md` |
| `enabled` | Interval/watcher scheduling only fires for enabled jobs |
| `trigger.kind` | `interval` · `watcher` |
| `trigger.everyMs` | Period for interval jobs |
| `trigger.source` | Watcher jobs: `codegraph` or `docgraph` to listen to one graph only (default: both) |
| `trigger.debounceMs` | Watcher jobs: collapse-window for a burst of file changes (default 2000) |
| `steps` | **Steps mode** — a fixed list of `{ tool, input }`, run in order via `callTool`. Deterministic, no model. |
| `prompt` | **Freeform mode** — a natural-language task run through `runAgentLoop` |
| `provider` / `persona` / `character` | Freeform: per-job overrides (default to a cheap local model) |
| `timeoutMs` | Freeform: cap on the run (default 300000) |

Two modes on purpose: don't burn a model on deterministic chores like
`deduplicate_memories`; do use one when the task needs reasoning (e.g. "summarise
what changed and write a wiki digest"). A job is steps-mode if it has a non-empty
`steps[]`, otherwise freeform if it has a non-empty `prompt`.

### Enabling it — one switch

`enabled: true` in the job + `APERIO_AGENT_JOBS=on` in the environment. The env var
is the **master switch**: with it off, jobs load but nothing fires, so a non-code
user never has to edit `jobs.json` to turn the feature off. See `.env.example`.

The switch is also flippable at runtime from the **Agents panel toggle** (no
restart, no `.env` editing) via `PUT /api/agents/enabled`. That route mutates
`process.env.APERIO_AGENT_JOBS` (so run-now gating reacts immediately), calls
`scheduler.setEnabled()` to start/tear-down interval + watcher wiring on the fly,
and persists the new value back to `.env` so it survives a restart (skipped under
`NODE_ENV=test`).

---

## API (`lib/routes/api-agents.js`)

Definition CRUD is **always available** so jobs can be configured before
auto-run is switched on; only *running* a job (and interval auto-run) is gated by
`APERIO_AGENT_JOBS=on`.

| Route | Purpose |
|-------|---------|
| `GET /api/agents` | List jobs, each with its most recent run (`{ enabled, jobs: [{ ...job, lastRun }] }`) |
| `GET /api/agents/:id` | One job's definition |
| `GET /api/agents/:id/runs?limit=N` | Run history, newest first (default 20, max 100) |
| `POST /api/agents` | Create a job (`400` no id / no steps|prompt, `409` id exists) |
| `PUT /api/agents/:id` | Update a job (id comes from the path) |
| `DELETE /api/agents/:id` | Remove a job (`404` if absent) |
| `POST /api/agents/:id/run` | **Run-now** — trigger immediately, returns `{ verdict, mode, entries, answer?, record }` |
| `PUT /api/agents/enabled` | Flip the master switch at runtime (`{ enabled: bool }`); mutates env, calls `scheduler.setEnabled`, persists to `.env`. `400` if not boolean |

Run-now status codes: `403` when the feature is off, `404` unknown id, `409`
already running (single-flight) or invalid, `200`/`500` with the run result. The
job is resolved from the DB (`store.getAgentJob`), not the legacy `jobs.json`.

### Run history

Every run (interval, manual, or watcher) is recorded best-effort to the
**`agent_runs` table** via `store.recordAgentRun()` — one row carrying
`{ job_id, started_at, finished_at, duration_ms, verdict, mode, trigger, error,
tools, answer }` (answer/tools capped). This is independent of the human-readable
`var/agents/aperio-agent-<id>.md` transcripts, which are still written. The
recorder never throws — a DB failure logs a warning and the job still succeeds.

---

## Watcher triggers (Phase 3)

The codegraph and docgraph chokidar watchers (`lib/codegraph/watcher.js`,
`lib/docgraph/watcher.js`) emit a `change` event `{ kind, root, relPath, op }` on a
shared `EventEmitter` after each **live** index/remove — only after the watcher is
ready, so the initial bulk index never fires a job. `server.js` creates that one
emitter, threads it into both `startAllWatchers` calls, and hands it to the
scheduler.

A `trigger.kind: "watcher"` job subscribes through the scheduler's `wireWatcherJobs`.
A burst of file events is **debounced per job** (default 2 s) and then fires one
`runJob(job, { kind: "watcher", changedFiles })` carrying the deduped relative
paths. Freeform jobs get the changed-file list appended to their prompt, so a job
like *"note what changed and write a wiki digest"* has something concrete to act on.
Watcher jobs honour the same `APERIO_AGENT_JOBS=on` master switch — with it off,
nothing subscribes.

```json
{
  "id": "doc-digest",
  "enabled": true,
  "trigger": { "kind": "watcher", "source": "docgraph", "debounceMs": 5000 },
  "prompt": "Summarise what changed in these documents in 3 bullets. Do not call write tools.",
  "provider": { "name": "deepseek", "model": "deepseek-v4-flash" },
  "timeoutMs": 120000
}
```

---

## Safety / conventions

- **Auto-run gated off by default** via `APERIO_AGENT_JOBS=on` — same idiom as
  `APERIO_CODEGRAPH` / `APERIO_DOCGRAPH`.
- **Single-flight per job** — a job cannot stack on itself; overlapping triggers
  collapse to one run.
- **`timer.unref()`** — the scheduler never keeps the process alive on its own.
- **Freeform runs are timeout-capped** so a stuck model can't wedge a job.
- **Run recorder is best-effort** — never throws, no-op under `NODE_ENV=test`
  (mirrors `writeRoundtableRecord`).
- **Same sandbox as chat** — background tools honor the existing
  `APERIO_ALLOWED_PATHS_TO_READ` / write guards. No new attack surface.
- **Cheap local model by default** in freeform job defs — background work must not
  silently hit a paid API.

`runAgentLoop` *returns* the final answer string, so the headless
`sinkEmitter` only has to satisfy `.send()` and collect tool names for the record —
it never decodes the event stream (and there is no single "terminal" event to key
off; `stream_end` fires once per inter-tool boundary).

---

## File layout

```
lib/workers/agent-scheduler.js       registry + runJob + writeAgentRunRecord + wireWatcherJobs + safeRecordRun + setEnabled (runtime switch) + reload (live reschedule)
lib/helpers/envFile.js               persistEnvVar() — write one KEY=value to .env (used by the runtime toggle)
lib/emitters/sinkEmitter.js          headless { send } sink for freeform runs
lib/codegraph/watcher.js             emits `change` events on live index/remove (Phase 3)
lib/docgraph/watcher.js              emits `change` events on live index/remove (Phase 3)
db/migrations{,-sqlite}/002_agent_jobs.sql   agent_jobs + agent_runs tables (Phase 4)
db/sqlite.js · db/postgres.js        listAgentJobs/getAgentJob/upsertAgentJob/deleteAgentJob/recordAgentRun/listAgentRuns
db/tables.js                          agent_jobs + agent_runs in the DB-browser whitelist
var/agents/aperio-agent-<id>.md       run transcripts (runtime, gitignored)
server.js                             shared watcherEvents bus + createAgentScheduler (jobs from DB + recordRun) + shutdown
lib/routes/api-agents.js              /api/agents CRUD + /runs history + /:id/run (DB-backed)
public/scripts/agents-panel.js        right-side panel: job list + lastRun + run-now + run-history
public/styles/agents-panel.css        ag-* styles (verdict badges, run rows); reuses cg-* chrome
public/index.html                     #agentsBtn nav + #agents-panel + #agents-backdrop
background-agents.md                  this file
```

---

## Phasing

- **Phase 1 (shipped):** `createAgentScheduler({ callTool })` — interval trigger +
  **steps mode** + run records + server wiring. Deterministic, testable offline.
- **Phase 2 (shipped):** headless sink emitter (`lib/emitters/sinkEmitter.js`) +
  freeform `runAgentLoop` mode (per-job provider/persona/character, timeout-capped)
  + `POST /api/agents/:id/run` ("run now").
- **Phase 3 (shipped):** watcher `EventEmitter` on codegraph/docgraph live index
  events + `watcher`-kind triggers (per-job debounce, `source`/`debounceMs`,
  `changedFiles` passed through to the run — freeform prompts get the file list).
- **Phase 4 (shipped):** jobs file → `agent_jobs` DB table (DB is now the
  source of truth; `jobs.json` is no longer read), `agent_runs` run-history table,
  store methods on both backends, scheduler reads jobs from the DB + records every
  run, `/api/agents` CRUD + `/runs` history + DB-backed run-now routes
  (`lib/routes/api-agents.js`), and the **UI panel** (`public/scripts/agents-panel.js`):
  a right-side sidebar listing every job with its trigger/mode/last-run verdict, a
  "Run now" button (gated on `APERIO_AGENT_JOBS=on`), and an expandable run-history
  view. The master switch is also flippable live from the panel (`setEnabled` +
  `PUT /api/agents/enabled`, persisted to `.env`), and **live rescheduling** is done:
  every CRUD mutation re-reads the DB and calls `scheduler.reload()`, so interval/
  watcher scheduling tracks changes without a restart. Optional remaining polish: a
  create/edit-job form in the panel (CRUD routes exist).

---

## How to test this feature

### 1. Automated (no server, no model — fastest)

```bash
# Just the scheduler suite (18 tests: loadJobs, steps mode, freeform mode,
# single-flight, timeout, gating, watcher triggers)
NODE_ENV=test node --test tests/lib/workers/agent-scheduler.test.js

# Full suite — should stay green (1537+ passing)
npm test
```

The unit tests inject a fake `callTool` / `createAgent`, so they cover both modes,
the timeout, and single-flight **without** Ollama/DeepSeek or a database.

### 2. Manual — steps mode (deterministic, no model bill)

```bash
# 1. Turn the master switch on (one line in .env)
#    APERIO_AGENT_JOBS=on
#
# 2. Start the server (it's already your default provider in .env)
npm start                    # → http://localhost:31337

# 3. Confirm the seeded example job is present + enabled (from the migration)
curl -s http://localhost:31337/api/agents | jq '.jobs[] | {id, enabled, lastRun}'

# 4. Trigger it immediately via the run-now API (don't wait 24h)
curl -s -X POST http://localhost:31337/api/agents/nightly-maintenance/run | jq
```

Expected: JSON `{ "verdict": "ok", "mode": "steps", "entries": [...] }`.
Then check the run history (DB), transcript, and logs:

```bash
curl -s http://localhost:31337/api/agents/nightly-maintenance/runs | jq '.runs[0]'
cat var/agents/aperio-agent-nightly-maintenance.md   # appended human-readable record
# server log line: [agent-scheduler] nightly-maintenance: steps ok in <n>ms
```

Negative checks (gating + error envelopes):

```bash
# With APERIO_AGENT_JOBS unset/off → 403
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:31337/api/agents/nightly-maintenance/run   # 403
# Unknown id → 404
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:31337/api/agents/nope/run                  # 404
```

### 3. Manual — freeform mode (exercises runAgentLoop + a model)

Create a second job via the API (uses your current chat provider when `provider`
is omitted; set it explicitly to pin a cheap model):

```bash
curl -s -X POST http://localhost:31337/api/agents -H 'content-type: application/json' -d '{
  "id": "digest",
  "enabled": true,
  "trigger": { "kind": "interval", "everyMs": 3600000 },
  "prompt": "Recall the 5 most recent memories and write a 3-bullet summary. Do not call write tools.",
  "provider": { "name": "deepseek", "model": "deepseek-v4-flash" },
  "timeoutMs": 120000
}' | jq

curl -s -X POST http://localhost:31337/api/agents/digest/run | jq '.verdict, .answer'
```

Expected: `"ok"` plus the model's answer string; the run record lists `tools used:`
(e.g. `recall`) and the answer body. To test the **timeout** path, set
`"timeoutMs": 1` and re-run → `{ "verdict": "error", "error": "...timed out..." }`.

### 4. Manual — interval auto-run

Give a job a short period so it fires on its own. The PUT triggers a live
`scheduler.reload()`, so **no restart is needed** — the scheduler re-wires and
(after its 30s initial delay) starts firing on the new interval:

```bash
curl -s -X PUT http://localhost:31337/api/agents/nightly-maintenance \
  -H 'content-type: application/json' \
  -d '{ "enabled": true, "trigger": { "kind": "interval", "everyMs": 60000 }, "steps": [{ "tool": "backfill_embeddings", "input": {} }] }'
# watch the log for "[agent-scheduler] rescheduled" then "active — N interval job(s)"
```

Wait ~30s, watch the log for the `[agent-scheduler]` run line, the growing
`var/agents/aperio-agent-<id>.md`, and rows in `GET /api/agents/:id/runs`.
Single-flight check: hammer the run-now endpoint twice fast on a slow job →
second call returns `409`.

### What "passing" looks like

- `npm test` green.
- Steps run-now → `200` + a record file appended.
- Freeform run-now → `200` + non-empty `answer` + `tools used:` in the record.
- Gating: `403` when off; `404` unknown id; `409` while a run is in flight.

---

## Suggestions for the next session (after restart)

Context that won't be obvious from the code alone:

1. **Don't put docs under `docs/`.** That folder is the published GitHub Pages site
   and non-site files placed there get cleaned (it ate the Phase 1 copy of this
   file). Repo-root design docs are the convention here.
2. **Jobs now live in the DB (`agent_jobs`), not `var/agents/jobs.json`** — that
   file is no longer read (Phase 4). The `002_agent_jobs.sql` migration seeds the
   `nightly-maintenance` example. `.env` is still gitignored; the shareable knob is
   `APERIO_AGENT_JOBS` in `.env.example` (default-off, present but commented).
3. **The seeded example job is `enabled: true`.** Once `APERIO_AGENT_JOBS=on`,
   `nightly-maintenance` runs `backfill_embeddings` + `deduplicate_memories`
   (dry-run) on its first interval. Harmless, but expected — not a bug.
4. **Watcher events only fire post-`ready`.** Both watchers set `ignoreInitial: true`
   and emit `change` only from the debounced live handler *after a successful*
   index/remove — the initial bulk `indexRepo` pass never triggers a watcher job.
   So a job won't stampede on first boot while the repo is indexed.
5. **`watcherEvents` is created unconditionally in `server.js`** (one `EventEmitter`),
   even when codegraph/docgraph are off — it just has no producers then, and the
   scheduler only subscribes when `APERIO_AGENT_JOBS=on` and watcher jobs exist.
6. **Phase 4 UI panel is now built** (`public/scripts/agents-panel.js` +
   `public/styles/agents-panel.css`, `#agentsBtn` nav + `#agents-panel` HTML). It
   reuses the `cg-*` chrome: a job list with `lastRun` status, a "Run now" button
   (`POST /api/agents/:id/run`, disabled when the master switch is off), and an
   expandable run-history view (`GET /api/agents/:id/runs`). The CRUD routes now live
   in `lib/routes/api-agents.js` (DB-backed; run-now reads `store.getAgentJob`, no
   longer the dead `jobs.json`). **Live rescheduling is done** — every CRUD mutation
   re-reads the DB and calls `scheduler.reload(jobs)`, which swaps the internal list
   and (if auto-run is active) tears down + re-wires interval/watcher timers, so a
   created/edited/deleted job takes effect without a restart. A create/edit-job form
   in the panel (the CRUD routes are ready) is the remaining optional polish.
7. **Master switch is toggleable from the Agents panel** (done — replaced the
   "expose it in setup.html" idea, which would have meant a trip to the wizard each
   time). The panel renders a switch (reuses the `reasoning-toggle` styles) wired to
   `PUT /api/agents/enabled`. The scheduler gained `setEnabled(on)` / `isEnabled()`:
   interval + watcher wiring now lives in a `startScheduling()` that can be wired and
   torn down at runtime, so flipping the toggle takes effect without a restart. The
   value is persisted to `.env` via `persistEnvVar()` (`lib/helpers/envFile.js`).
8. **Live rescheduling is done** (see #6) — `scheduler.reload(jobs)` swaps the job
   snapshot and re-wires timers when active; the CRUD routes call it after every
   mutation with a fresh `store.listAgentJobs()`. So the old "job list is snapshotted
   at boot" caveat no longer holds — API job edits take effect immediately.
8. **Verify watcher triggers live.** The unit tests drive a fake `EventEmitter`; a
   real end-to-end check is `APERIO_DOCGRAPH=on APERIO_AGENT_JOBS=on` + a watcher
   job, then touch a doc and watch `var/agents/aperio-agent-<id>.md` grow with a
   `· watcher (N files)` run header.

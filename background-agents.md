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

Jobs live in `var/agents/jobs.json` (runtime config — `var/` is gitignored, like
`var/roundtables/`). Missing file → no jobs, scheduler stays idle.

```json
{
  "jobs": [
    {
      "id": "nightly-maintenance",
      "enabled": true,
      "trigger": { "kind": "interval", "everyMs": 86400000 },
      "steps": [
        { "tool": "backfill_embeddings", "input": {} },
        { "tool": "deduplicate_memories", "input": { "threshold": 0.97, "dry_run": true } }
      ]
    }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `id` | Unique; names the run-record file `var/agents/aperio-agent-<id>.md` |
| `enabled` | Interval scheduling only fires for enabled jobs |
| `trigger.kind` | `interval` · `watcher` (Phase 3) |
| `trigger.everyMs` | Period for interval jobs |
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

---

## Run-now API

`POST /api/agents/:id/run` triggers a defined job immediately and returns its
result (`{ verdict, mode, entries, answer?, record }`). Gated by the same
`APERIO_AGENT_JOBS=on` switch:

- `403` when the feature is off,
- `404` when no job has that id,
- `409` when the job is already running (single-flight) or invalid,
- `200`/`500` with the run result otherwise.

This is what a future "run now" button (Phase 4 panel) calls, and it makes the
freeform path exercisable without waiting on an interval.

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
lib/workers/agent-scheduler.js       registry + runJob + writeAgentRunRecord
lib/emitters/sinkEmitter.js          headless { send } sink for freeform runs
var/agents/jobs.json                  job defs (runtime, gitignored)
var/agents/aperio-agent-<id>.md       run transcripts (runtime, gitignored)
server.js                             wires createAgentScheduler + shutdown
lib/routes/api.js                     POST /api/agents/:id/run
background-agents.md                  this file
```

---

## Phasing

- **Phase 1 (shipped):** `createAgentScheduler({ callTool })` — interval trigger +
  **steps mode** + run records + server wiring. Deterministic, testable offline.
- **Phase 2 (shipped):** headless sink emitter (`lib/emitters/sinkEmitter.js`) +
  freeform `runAgentLoop` mode (per-job provider/persona/character, timeout-capped)
  + `POST /api/agents/:id/run` ("run now").
- **Phase 3:** watcher `EventEmitter` on codegraph/docgraph index events +
  `watcher`-kind triggers (e.g. "on doc change, note what changed").
- **Phase 4:** jobs file → DB table; UI panel showing job status + run history
  (reuse the codegraph/docgraph panel pattern).

---

## How to test this feature

### 1. Automated (no server, no model — fastest)

```bash
# Just the scheduler suite (14 tests: loadJobs, steps mode, freeform mode,
# single-flight, timeout, gating)
NODE_ENV=test node --test tests/lib/workers/agent-scheduler.test.js

# Full suite — should stay green (1533+ passing)
npm test
```

The unit tests inject a fake `callTool` / `createAgent`, so they cover both modes,
the timeout, and single-flight **without** Ollama/DeepSeek or a database.

### 2. Manual — steps mode (deterministic, no model bill)

```bash
# 1. Turn the master switch on (one line in .env)
#    APERIO_AGENT_JOBS=on
#
# 2. Confirm the example job is present + enabled
cat var/agents/jobs.json     # nightly-maintenance, enabled: true, steps mode

# 3. Start the server (it's already your default provider in .env)
npm start                    # → http://localhost:31337

# 4. Trigger it immediately via the run-now API (don't wait 24h)
curl -s -X POST http://localhost:31337/api/agents/nightly-maintenance/run | jq
```

Expected: JSON `{ "verdict": "ok", "mode": "steps", "entries": [...] }`.
Then check the transcript and logs:

```bash
cat var/agents/aperio-agent-nightly-maintenance.md   # appended run record
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

Add a second job to `var/agents/jobs.json` (uses your current chat provider when
`provider` is omitted; set it explicitly to pin a cheap model):

```json
{
  "id": "digest",
  "enabled": true,
  "trigger": { "kind": "interval", "everyMs": 3600000 },
  "prompt": "Recall the 5 most recent memories and write a 3-bullet summary. Do not call write tools.",
  "provider": { "name": "deepseek", "model": "deepseek-v4-flash" },
  "timeoutMs": 120000
}
```

```bash
curl -s -X POST http://localhost:31337/api/agents/digest/run | jq '.verdict, .answer'
```

Expected: `"ok"` plus the model's answer string; the run record lists `tools used:`
(e.g. `recall`) and the answer body. To test the **timeout** path, set
`"timeoutMs": 1` and re-run → `{ "verdict": "error", "error": "...timed out..." }`.

### 4. Manual — interval auto-run

Set a short period to watch it fire on its own (the scheduler waits 30s after boot,
then runs on the interval):

```json
"trigger": { "kind": "interval", "everyMs": 60000 }
```

Start the server, wait ~30s, watch the log for the `[agent-scheduler]` run line and
the growing `var/agents/aperio-agent-<id>.md`. Single-flight check: hammer the
run-now endpoint twice fast on a slow job → second call returns `409`.

### What "passing" looks like

- `npm test` green.
- Steps run-now → `200` + a record file appended.
- Freeform run-now → `200` + non-empty `answer` + `tools used:` in the record.
- Gating: `403` when off; `404` unknown id; `409` while a run is in flight.

---

## Suggestions for the next session (after restart)

Context that won't be obvious from the code alone:

1. **Phase 2 is uncommitted.** The working tree has the freeform mode, sink emitter,
   run-now route, env + jobs config, and this doc — none committed yet (Phase 1 was
   committed as `d0f4c2e`). First step: review `git status` / `git diff`, then commit
   Phase 2 if happy. Untracked: `lib/emitters/sinkEmitter.js`, `background-agents.md`.
   Modified: `lib/workers/agent-scheduler.js`, `lib/routes/api.js`, `server.js`,
   `tests/lib/workers/agent-scheduler.test.js`, `FEATURES.md`, `.env.example`.
2. **Don't put docs under `docs/`.** That folder is the published GitHub Pages site
   and non-site files placed there get cleaned (it ate the Phase 1 copy of this
   file). Repo-root design docs are the convention here.
3. **`.env` / `var/agents/jobs.json` are gitignored** — local-only. The shareable
   knobs live in `.env.example` (the `APERIO_AGENT_JOBS` block) and in this doc.
   `.env` currently has the switch present but commented (default-off).
4. **The example job is `enabled: true`.** Once `APERIO_AGENT_JOBS=on`,
   `nightly-maintenance` runs `backfill_embeddings` + `deduplicate_memories`
   (dry-run) on its first interval. Harmless, but expected — not a bug.
5. **Next build target: Phase 3 (watcher triggers).** Add an `EventEmitter` to
   `lib/codegraph/watcher.js` + `lib/docgraph/watcher.js` that fires on index
   add/change/unlink, then a `wireWatcherJobs` debouncer in the scheduler so
   `trigger.kind: "watcher"` jobs fire with `{ changedFiles }`. The scheduler
   already passes `triggerCtx` through `runJob` → records, so the plumbing is ready.
6. **Possible Phase 2.5 polish (optional):** expose `APERIO_AGENT_JOBS` in the setup
   wizard (`public/setup.html`) so non-code users flip it without touching `.env`;
   add a `GET /api/agents` list route to back a future status panel.
7. **Verify freeform against a real model.** The unit tests fake the agent; a quick
   live run-now of a freeform job (section 3 above) is the only thing that proves the
   `createAgent` → `runAgentLoop` → sink wiring end-to-end.

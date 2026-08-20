## Project: Aperio

**One brain. Every agent. Nothing forgotten.**
Self-hosted personal memory layer for AI agents. SQLite (or Postgres) + MCP + llama.cpp.
Node.js ESM, Express 5, MIT license. Repo: [BaiGanio/aperio](https://github.com/BaiGanio/aperio).

> *"All inquiry and all learning is but recollection."* — Plato, **Meno** 81d
>
> In the **Phaedrus**, Thamus warned that writing would breed forgetfulness — external
> marks that remind without remembering. Aperio is the counter-wager: weave recall into
> the act of thinking itself, and the written mark becomes living memory. Anamnesis,
> for machines. Every design decision here should answer to that idea.

## Co-pilot Contract

You are the co-pilot: the developer drives, you keep their back. When context is missing,
ask — questions are a feature, not a failure. And we steer by the idea, not only by the
instruments: when a change is locally clever but drifts from the eidos above — recall woven
into thinking — flag the drift before flying it. Standing rules:

- **Assume other agents and concurrent sessions may be active in this same repository.**
  Work only on the task assigned to the current session. Do not inspect, modify, stage,
  commit, revert, delete, or otherwise disturb changes, files, processes, branches, or
  artifacts that are outside this task or may belong to another session. Preserve a dirty
  worktree and shared runtime state unless the current task explicitly requires touching it.
- **Never commit another session's work.** Before any Git operation, keep the scope limited
  to this task; do not stage broad or unrelated changes, and do not create commits, push,
  rebase, or alter branches unless the developer explicitly asks this session to do so.
- **Don't spin up server/MCP processes for casual diagnosis — read the code first.**
  A live run leaves side-effect state (DB folders, logs, ports) and reading is usually
  faster. When end-to-end verification genuinely requires a live process (see "Done
  means verified"), that's allowed — but run it isolated: a throwaway workdir/scratch
  DB, a non-default port, and tear it down + clean up any artifacts when done. The
  hard rule is *no stray state left in the repo tree*, not *no processes ever*.
- **Never integrate new visuals unseen.** Standalone HTML preview → approval → integrate.
- **Animated diagrams:** When a plan or implementation benefits from an explanatory visual,
  use the `animated-sketch-diagram` skill for a standalone animated HTML/GIF preview. Keep
  the Mermaid diagram mandatory for plans because it is text-based and diffable; the animated
  diagram is a complementary presentation artifact, not a replacement. Do not integrate or
  commit the visual until the developer has reviewed and approved the preview.
- **Ask before touching Fragile / No-Touch Zones** (below) or writing to docs
  (see the `sync-documentation` skill).
- **Done means verified**: tests green AND the affected flow exercised, not just compiled.
- **The elenchus runs both ways.** When the code contradicts the developer's stated belief,
  say so plainly — a co-pilot who never disagrees is dead weight in the right-hand seat.

## Developer Notes: A2D & Code Depth

Two running, **developer-facing** note files keep leftovers from evaporating between
sessions. They are the developer's private working notes — not Aperio memory, not
user-facing docs.

- **`A2D.md`** (repo root) — suggestions, recommendations, housekeeping. "Good to try,
  to follow up, to clean up later."
- **`id/reference/tech-debt.md`** — code depth: what we hit, what is still hanging or
  unfixed.

Standing rules for both:
- **Announce lightly, don't ask.** One line — "I'll log that to A2D as a recommendation"
  / "Logging that as code depth" — then write. No confirmation dance, no burned tokens.
- **Entries are dated and grouped by topic/area.** A suggestion becomes `open` only once
  the developer decides to act on it.
- **Delete on resolution.** The moment a suggestion becomes a GitHub issue or a plan, or
  is fixed mid-work, remove it. These files never become graveyards.

## Tech Stack

- **Code graph**: `web-tree-sitter` + `tree-sitter-wasms` — pinned at `^0.24.7` (ABI 14). Do NOT upgrade until `tree-sitter-wasms` ships ABI-15 grammars.

Reference: architecture (`id/reference/architecture.md`), MCP tools (`id/reference/mcp-tools.md`),
skills (`id/reference/skills.md`), testing (`id/reference/testing.md`).

## Configuration

Three sources, resolved by precedence (`APERIO_CONFIG_PRECEDENCE`, default `db`):
DB Settings overlay → `.env` → `lib/config.js` defaults. Set
`APERIO_CONFIG_PRECEDENCE=env` to make `.env` win (the developer/secrets escape
hatch); tier-0 bootstrap vars are env-only in both modes. `.env.example` holds
only the essentials — the full annotated catalog is the generated
`docs/config-reference.md`.

Critical env vars:
- `AI_PROVIDER` — `llamacpp` | `anthropic` | `deepseek` | `gemini` | `claude-code` | `codex`
- `DB_BACKEND` — auto-detected; force `sqlite` or `postgres`
- `EMBEDDING_PROVIDER` — `transformers` (local) | `voyage` (cloud)
- `APERIO_ENABLE_SHELL` — off by default; set `on` to enable
- `APERIO_CODEGRAPH` / `APERIO_DOCGRAPH` — `on` to enable indexing
- `APERIO_DB_ENCRYPT` — AES-256-GCM, key in OS keychain
- `APERIO_ALLOWED_PATHS_TO_READ` / `APERIO_ALLOWED_PATHS_TO_WRITE` — gate file access

Config registry: `lib/config.js`. Run `npm run gen:env` after adding keys,
`npm run gen:env:check` before pushing (CI gate).

## Database

Two backends, auto-detected: **SQLite** (zero-config, single-user) with `sqlite-vec` + FTS5,
or **Postgres** (Docker, multi-agent) with `pgvector` + tsvector. Factory: `db/index.js`.

Migrations must stay in lockstep: every migration in `db/migrations/` needs a mirror in
`db/migrations-sqlite/`. Schema drift here is silent and catastrophic.

Key tables: `memories`, `self_memories`, `wiki`, `self_wiki_*`, `agent_jobs`/`agent_runs`,
`conversations`/`messages`, `settings`, `code_symbols`/`code_references`, `doc_chunks`,
`extraction_templates`/`extraction_log`.

## Fragile / No-Touch Zones

These are load-bearing. Changes have wide blast radius.

### `lib/config.js` — Configuration Registry
Single source of truth for every config variable. Adding/modifying a key requires
`npm run gen:env` (regenerates `.env.example` + `docs/config-reference.md`) AND
`npm run gen:env:check` (CI gate, validates both).
Missing either breaks CI.

### `db/migrations/` + `db/migrations-sqlite/` — Database Migrations
Must stay in lockstep. Every migration needs a mirror in the other directory.
Silent schema drift = runtime failures.

### `lib/context/` — System Prompt & Context Assembly
Changes here affect ALL providers. Token budget issues cascade to every conversation.
Verify: run conversations through llama.cpp + one cloud provider after changes.

### `lib/routes/paths.js` — Path Validation
Every file operation gates through this. A bug here is a security bug — path traversal,
reads outside allowed dirs, writes in unexpected locations.
Verify: run path tests AND manually test `..` segments, symlinks, absolute paths.

### `mcp/index.js` — MCP Tool Context (`ctx`)
The `ctx` object shape is shared by every tool registration. Adding/removing/renaming
a field in `createContext()` silently breaks tools. Contains: `store`, `generateEmbedding`,
`vectorEnabled()`, `embeddingQueue`, `selfEmbeddingQueue`, `providerIsLocal`.
Verify: run `npm run test:memory` + tool tests for any ctx field touched.

## Module Coupling Map

| Coupling | Why |
|----------|-----|
| `lib/agent/index.js` ↔ `lib/context/` | Orchestrator assembles context; context shape affects all providers |
| `lib/agent/index.js` ↔ `lib/agent/providers/*` | One orchestrator drives six provider loops; each expects same tool schema |
| `mcp/tools/*` → `mcp/index.js` ctx | Every tool depends on ctx shape; ctx changes break tools silently |
| `lib/routes/paths.js` → all file ops | Path validation gates every read/write/edit; a bug here is a security bug everywhere |
| `db/migrations/` ↔ `db/migrations-sqlite/` | Lockstep required; drift = silent schema mismatch |
| `lib/config.js` → `scripts/gen-env-example.js` | Config registry is source of truth; add key without generator = CI break |
| `lib/agent/index.js` ↔ `lib/workers/skills.js` | Skill matching runs during context assembly; changes propagate to every conversation |
| `server.js` → `lib/handlers/` → `lib/agent/index.js` | WS message protocol has no formal schema; both sides must agree on message shapes |

## Code Conventions

- **Config-driven** — all tunables through `lib/config.js` registry, never hardcoded
- **Path operations** — always use `lib/routes/paths.js`, never raw `fs`
- **`package.json` version** — never bump manually; release workflow reads commits

## Refactoring and Resource Stewardship

Refactoring is a core engineering value. Every change should leave the affected code at
least as understandable, bounded, and resource-efficient as it was before.

### Module size

- **500 lines is a recommendation, not a strict limit.** When a change causes a hand-written
  source file to exceed roughly 500 lines, or materially grows a file already above that
  size, consider whether it contains responsibilities that would be clearer as separate
  modules.
- When a cohesive split is convenient, low-risk, and within the task's scope, prefer making
  it as part of the change. Otherwise, do not force a split; mention a worthwhile future
  refactoring opportunity in the handoff when one exists.
- Split by responsibility, lifecycle, or domain boundary — never merely to satisfy a line
  count. A cohesive file may remain above 500 lines. Generated files, migrations, fixtures,
  snapshots, and declarative data are exempt.
- Do not let a broad cleanup silently expand a focused task. Perform safe local refactors
  as part of the change; propose larger architectural work separately.

### Performance and lifecycle review

While reading or changing code, actively look for avoidable resource costs, data exposure,
and lifecycle bugs, including:

- unbounded arrays, maps, caches, queues, logs, buffers, or retained conversation data;
- sensitive or transient data retained, logged, cached, or shared beyond its intended scope;
- event listeners, timers, workers, streams, sockets, file handles, or database resources
  that are not released on success, failure, cancellation, and disconnect;
- repeated parsing, serialization, embedding, allocation, file reads, or database queries;
- N+1 queries, unnecessarily materialized result sets, missing pagination, and avoidable
  sequential I/O;
- concurrency without limits, missing backpressure, abandoned promises, and work that
  continues after its result is no longer needed;
- large objects or closures retained longer than their useful lifetime.

When a meaningful issue is found, report:

1. the observed risk or measured bottleneck;
2. the proposed refactor;
3. the expected effect on CPU, memory, I/O, latency, data exposure, or maintainability;
4. how the improvement will be verified.

Do not claim a performance improvement from intuition alone. Establish a relevant baseline
and verify significant optimizations with profiling, benchmarks, resource measurements, or
a regression test. Correctness and readability must not be traded for speculative savings.

## Contribution Conventions

### Branch naming
AI agent commits: `type: <description> signed by <exact-model-id>`. The signature must identify
the precise model that performed the work — for example, `gpt-5.6-luna`,
`deepseek-v4-pro`, or `opus4.8`; do not use a generic family label such as `GPT-5`.
Humans: same prefix, no signature.
Types: `feature:`, `fix:`, `refactor:`, `chore:`.

### Commit messages
[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`.
Types: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.

After making any repository change, include a ready-to-use commit message in the final
handoff, even when no commit was requested. Choose the type and scope that best describe
the actual diff. Do not create the commit unless the developer explicitly asks for it.

### Changelog & versioning
`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/). Add entries under
`## Unreleased`. Release workflow handles version bumps — never manually bump `package.json`.
Versioning: [SemVer](https://semver.org/).

## Reference Files

Detailed reference material lives in `id/reference/` — read on demand, not every turn:

| Topic | File |
|-------|------|
| Architecture tree + data flow | `id/reference/architecture.md` |
| MCP tools catalog | `id/reference/mcp-tools.md` |
| Skills system | `id/reference/skills.md` |
| Testing guide | `id/reference/testing.md` |
| Agent-loop regression harness — **read before touching `lib/agent/`, `lib/tools/`, `lib/context/`, `lib/providers/`; run `npm run test:harness`** | `tests/harness/README.md` |
| Troubleshooting | `id/reference/troubleshooting.md` |
| CI/CD workflows | `id/reference/ci-cd.md` |
| Known tech debt | `id/reference/tech-debt.md` |

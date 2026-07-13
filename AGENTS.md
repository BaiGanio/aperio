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

- **Don't spin up server/MCP processes for casual diagnosis — read the code first.**
  A live run leaves side-effect state (DB folders, logs, ports) and reading is usually
  faster. When end-to-end verification genuinely requires a live process (see "Done
  means verified"), that's allowed — but run it isolated: a throwaway workdir/scratch
  DB, a non-default port, and tear it down + clean up any artifacts when done. The
  hard rule is *no stray state left in the repo tree*, not *no processes ever*.
- **Never integrate new visuals unseen.** Standalone HTML preview → approval → integrate.
- **Ask before touching Fragile / No-Touch Zones** (below) or writing to docs
  (see Documentation Sync).
- **Done means verified**: tests green AND the affected flow exercised, not just compiled.
- **The elenchus runs both ways.** When the code contradicts the developer's stated belief,
  say so plainly — a co-pilot who never disagrees is dead weight in the right-hand seat.

## Quick Start

```bash
git clone --depth 1 -b dev https://github.com/BaiGanio/aperio.git
cd aperio && npm install
cp .env.example .env          # edit AI_PROVIDER + model
npm run migrate               # or migrate:sqlite
npm run start:local           # :31337, browser auto-opens
```

Key commands: `npm run chat:local`, `npm run mcp`, `npm test`, `npm run test:ci`,
`npm run gen:env`, `npm run gen:env:check`, `npm run config:sync`.

## Tech Stack

- **Runtime**: Node.js ESM — `import`/`export`, no `require`
- **Server**: Express 5 + WebSocket (`ws`)
- **Database**: SQLite (`better-sqlite3` + `sqlite-vec` + FTS5) or Postgres (`pg` + `pgvector`). Auto-detected by `db/index.js`.
- **MCP**: `@modelcontextprotocol/sdk` stdio transport — `npm run mcp`
- **Embeddings**: HuggingFace `@huggingface/transformers` (local, default) or Voyage AI (cloud)
- **AI providers**: llama.cpp (vendored, local), Anthropic, DeepSeek, Gemini, Claude Code, Codex CLI
- **Testing**: Node.js native test runner (`node --test`), `c8` coverage
- **Code graph**: `web-tree-sitter` + `tree-sitter-wasms` — pinned at `^0.24.7` (ABI 14). Do NOT upgrade until `tree-sitter-wasms` ships ABI-15 grammars.

Reference: architecture (`id/reference/architecture.md`), MCP tools (`id/reference/mcp-tools.md`),
skills (`id/reference/skills.md`), testing (`id/reference/testing.md`).

## Configuration

Three sources, resolved by precedence (`APERIO_CONFIG_PRECEDENCE`): `.env` → DB settings panel → `lib/config.js` defaults.

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
`conversations`/`messages`, `settings`, `code_symbols`/`code_references`, `doc_chunks`.

## Fragile / No-Touch Zones

These are load-bearing. Changes have wide blast radius.

### `lib/config.js` — Configuration Registry
Single source of truth for every config variable. Adding/modifying a key requires
`npm run gen:env` (regenerates `.env.example`) AND `npm run gen:env:check` (CI gate).
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
`vectorEnabled()`, `embeddingQueue`, `providerIsLocal`.
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

## Security Model

- **Path safety**: all file ops through `lib/routes/paths.js`. Read/write gated separately via
  `APERIO_ALLOWED_PATHS_TO_READ` / `APERIO_ALLOWED_PATHS_TO_WRITE`. Default: project root only.
- **Network guard**: `lib/helpers/netGuard.js` — DNS rebinding, host/Origin validation
- **Auth**: optional shared-secret token (`APERIO_AUTH_TOKEN`), per-session cookie for `/uploads`/`/scratch`
- **Rate limiting**: Express middleware in `lib/helpers/rateLimit.js`
- **Shell sandbox**: allowlisted binaries, no operators, 60s timeout, off by default
- **DB encryption**: AES-256-GCM, key in OS keychain (`db/encrypt.js`)
- **Crash breaker**: `lib/helpers/crashBreaker.js` — exits on repeated fatals, supervisor restarts

## Code Conventions

- **ESM only** — `import`/`export`, no `require`. `createRequire` only where unavoidable.
- **Node.js native test runner** — `node --test`, `import assert from "node:assert/strict"`
- **No TypeScript** — plain JavaScript with JSDoc annotations
- **Config-driven** — all tunables through `lib/config.js` registry, never hardcoded
- **Defensive error handling** — `server.js` has global `uncaughtException`/`unhandledRejection` guards
- **Path operations** — always use `lib/routes/paths.js`, never raw `fs`
- **`package.json` version** — never bump manually; release workflow reads commits

## Contribution Conventions

### Branch naming
AI agent commits: `type: <description> signed by <model-name>`. Humans: same prefix, no signature.
Types: `feature:`, `fix:`, `refactor:`, `chore:`.

### Commit messages
[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`.
Types: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.

### Changelog & versioning
`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/). Add entries under
`## Unreleased`. Release workflow handles version bumps — never manually bump `package.json`.
Versioning: [SemVer](https://semver.org/).

## Plans

When asked to write or design a plan — architecture, feature design, migration strategy,
refactor roadmap — produce a plan document at `trash/plans/<slug-folder-name>/<slug-name-itself>.md`. Use kebab-case slugs.

### Plan structure
Every plan must include:

1. **Objective** — one sentence: the problem being solved and why it matters
2. **Diagram** — a [Mermaid](https://mermaid.js.org/) diagram showing key components and their
   relationships. Mermaid is text-based, renders on GitHub, and is diffable. For UI mockups,
   generate a PNG with `sharp` or the `canvas-design` skill; store alongside as `<slug>.png`.

   ```mermaid
   graph TD
       A[Input] --> B[Process]
       B --> C[Output]
   ```

3. **Model recommendation** — which model/provider to use for execution, with rationale.
   See model selection principles below. Include: recommended model, estimated input/output
   tokens, estimated cost, and one-sentence rationale.

4. **Steps** — ordered, each with a concrete acceptance criterion ("works when…"), and a
   reference to the companion test file (`trash/plans/<slug>-tests.md`) where each step's
   tests are defined in detail.
5. **Risks** — what can go wrong, mitigation for each
6. **Doc updates** — which files need changes after implementation (see Documentation Sync)

### TDD — Tests First

Every plan MUST have a companion test file at `trash/plans/<slug>-tests.md`, produced
alongside the plan itself. When the plan is executed, the verification criteria defined
in the test file are validated **before** the implementation is considered complete —
verify-first, not verify-after.

Tests adapt to the plan's domain — "test" means "provable criterion that the work is done
right." The structure is universal; the content is domain-specific:

| Plan domain | What a "test" means |
|-------------|---------------------|
| Software feature | Code test (unit, integration, e2e, contract) |
| Engineering (e.g., water mill) | Physical criterion (flow rate, RPM, load, tolerances) |
| Business / strategy | Measurable outcome (revenue, conversion, time-to-market) |
| Content / documentation | Review checklist, accuracy checks, style compliance |
| Infrastructure / ops | Health checks, SLO thresholds, chaos-test assertions |

**Test file structure** (`trash/plans/<slug>-tests.md`):

1. **Coverage map** — which plan steps each test group covers, so nothing falls through
   the cracks. Use a simple table:

   | Plan step | Test group | Coverage |
   |-----------|-----------|----------|
   | Step 1    | Unit: …   | …        |
   | Step 2    | …         | …        |

2. **Test cases** — each test case has:
   - **Name** — descriptive, unique across the file
   - **Input / setup** — preconditions, fixtures, mock data, or domain-specific preparation
   - **Expected behavior** — concrete, measurable outcome; avoid "should work"
   - **Assertions** — the specific checks that must pass (code assertions, physical
     measurements, financial targets — whatever the domain demands)
   - **Edge cases** — boundary conditions, failure modes, edge inputs, worst-case scenarios

3. **Test execution order** — dependencies between test groups. Tests within a group
   are independent; groups may depend on earlier groups.

4. **Diagrams** (optional) — if a test scenario involves data flow, state transitions,
   or component interactions that are easier to see than read, include a Mermaid diagram.

5. **Required setup** — any fixtures, tools, environment, migrations, config, or seed
   data needed before the test suite can run.

When a plan is executed:
1. Read the companion test file first
2. Prepare the verification criteria and confirm the current state does **not** satisfy
   them — red means the test file has teeth (for code: write stubs and watch them fail;
   for engineering: measure the current output against the target)
3. Implement the plan steps until all criteria are met (green)
4. Update the test file if discoveries during implementation change the expected outcome
5. Confirm the coverage map still holds — no orphaned plan steps, no untested paths

### Model selection
Right-size the model to the task. A typo fix does not need a frontier model. A security
audit does not belong on a 7B local model. Default priority:

1. **Local first** — llama.cpp for code edits, file ops, structured reasoning. Zero API cost.
2. **Cheapest capable cloud** — DeepSeek for reasoning-heavy work, Gemini Flash for throughput
3. **Precision-critical only** — Anthropic when instruction-following is paramount

For current pricing and capability comparisons, query the project's own memory/wiki:
`wiki_get("model-selection")` or `recall("model pricing comparison")`.
If that data is unavailable, use published pricing as of your knowledge cutoff.

## Documentation Sync

After any change that alters behavior, adds a feature, fixes a security issue,
or changes configuration, check whether these files need updates:

| Change type | Files to update |
|-------------|-----------------|
| New feature / tool | `FEATURES.md`, `CHANGELOG.md` |
| API / config change | `README.md` (if documented there), `CHANGELOG.md` |
| Security fix | `SECURITY.md`, `CHANGELOG.md` |
| Dependency change | `README.md` (if listed), `CHANGELOG.md` |
| Architecture change | `id/reference/architecture.md`, `CHANGELOG.md` |
| Breaking change | `README.md`, `FEATURES.md`, `CHANGELOG.md` |
| New/removed MCP tool | `id/reference/mcp-tools.md`, `CHANGELOG.md` |
| New/removed skill | `id/reference/skills.md`, `CHANGELOG.md` |

**Always confirm with the user before writing doc updates.** State which files need changes
and why. Wait for confirmation. Never silently modify documentation.

After a commit, push, or release, re-check this table and offer to update any stale docs.

## Reference Files

Detailed reference material lives in `id/reference/` — read on demand, not every turn:

| Topic | File |
|-------|------|
| Architecture tree + data flow | `id/reference/architecture.md` |
| MCP tools catalog | `id/reference/mcp-tools.md` |
| Skills system | `id/reference/skills.md` |
| Testing guide | `id/reference/testing.md` |
| Troubleshooting | `id/reference/troubleshooting.md` |
| CI/CD workflows | `id/reference/ci-cd.md` |
| Known tech debt | `id/reference/tech-debt.md` |

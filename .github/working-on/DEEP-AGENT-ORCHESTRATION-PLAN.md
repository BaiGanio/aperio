# Aperio Agent Orchestration Plan

Status: Phase 3 complete; next slice is Phase 4.1 `AgentSpec` schema.

Created: 2026-07-06

Source inspiration: `langchain-ai/deepagents`

## How To Load This Plan

Do not feed every orchestration note to an implementation agent by default.

For normal continuation work, provide only:

1. This index file.
2. `.github/working-on/DEEP-AGENT-ORCHESTRATION-ACTIVE.md`.
3. The source/test files relevant to the next unchecked slice.

Open `.github/working-on/DEEP-AGENT-ORCHESTRATION-COMPLETED.md` only when a
future change needs historical context about Phases 1-3, earlier verification
records, or why a completed design choice exists.

## Objective

Extend Aperio from a shared local memory layer with chat and background agents
into a local-first agent control plane:

- full tool results survive without consuming model context;
- sensitive operations pause and resume durably;
- agent behavior is assembled through explicit lifecycle middleware;
- agents delegate isolated work with narrower capabilities;
- prompts, skills, and orchestration policy improve through reproducible evals;
- long-running work iterates with fresh context and persistent artifacts.

The implementation remains native JavaScript and preserves Aperio's existing
provider loops, MCP tools, memory model, security controls, and SQLite/Postgres
backends. LangGraph and Deep Agents are references, not new runtime
dependencies.

## Non-Goals

- Replacing Aperio's temporal/vector memory with Markdown files.
- Replacing the provider-specific loops in one migration.
- Giving autonomous agents unrestricted host shell access.
- Treating subagents as independent users with unrestricted parent-state access.
- Shipping self-modifying prompts or skills without evaluation and user review.
- Combining this work with unrelated refactors, translations, or docs churn.

## Architecture Constraints

- Local Ollama remains fully supported, including small context windows.
- Cloud providers never receive self-memory or local-only content.
- Existing prompt-injection taint and confirm-before-write behavior cannot be
  weakened.
- Permissions are enforced by code at tool/backend boundaries, not only prompts.
- A child agent may inherit or narrow permissions, never silently broaden them.
- Parent and child message histories remain isolated.
- Stored tool arguments and artifacts pass existing secret-redaction and file
  permission rules.
- New persisted data works on both SQLite and Postgres.
- All new background activity has time, iteration, concurrency, and cancellation
  limits.

## Commit Discipline

Before starting any slice:

1. `git status --short` must be clean.
2. Identify exact source and test files expected to change.
3. Do not include drive-by formatting, generated files, or unrelated fixes.

Before committing a slice:

1. Run narrow tests for the changed subsystem.
2. Run syntax checks and `git diff --check`.
3. Inspect both `git diff` and `git diff --cached`.
4. Stage explicit paths; never use `git add -A` for this project.
5. Keep implementation and direct tests in the same commit.
6. Leave broader UI, documentation, migration, and cleanup changes for named
   slices.

Recommended prefixes:

- `feat(agent):`
- `feat(context):`
- `feat(security):`
- `feat(evals):`
- `test(agent):`
- `docs(agent):`

Do not push automatically.

## Phase Map

- [x] Phase 1 — Lossless tool-result offloading.
- [x] Phase 2 — Aperio lifecycle middleware.
- [x] Phase 3 — Durable interrupts and resumable actions.
- [ ] Phase 4 — Agent specifications and permission narrowing.
- [ ] Phase 5 — Isolated task delegation.
- [ ] Phase 6 — Explicit planning for long tasks.
- [ ] Phase 7 — Evaluation-driven harness improvement.
- [ ] Phase 8 — Bounded fresh-context iteration.
- [ ] Phase 9 — Memory scopes and learned procedures.

## Next Slice

Start with Phase 4.1 in
`.github/working-on/DEEP-AGENT-ORCHESTRATION-ACTIVE.md`:

- define a validated `AgentSpec` schema;
- include model/provider override, identity/persona, character, skills, memory
  scopes, tool allowlist, filesystem rules, interrupt policy, timeout, recursion
  depth, concurrency, and output schema;
- reject unknown security-sensitive fields.

Expected commit: `feat(agent): define validated agent specifications`.

## Companion Files

- `.github/working-on/DEEP-AGENT-ORCHESTRATION-ACTIVE.md` — active roadmap,
  release gates, and future phase acceptance criteria.
- `.github/working-on/DEEP-AGENT-ORCHESTRATION-COMPLETED.md` — completed
  Phases 1-3, drill records, and verification notes.

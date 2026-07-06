# Aperio Agent Orchestration Plan

Status: Phase 1 complete — Phase 2 in progress (2.1–2.2 complete)

Created: 2026-07-06

Source inspiration: `langchain-ai/deepagents`

Implementation rule: every numbered slice below is completed and verified as a
small reviewable change. The implementation assistant leaves changes unstaged
and uncommitted; the maintainer reviews and creates the clean commit.

## Objective

Extend Aperio from a shared local memory layer with chat and background agents
into a local-first agent control plane:

- full tool results survive without consuming the model context;
- sensitive operations can pause and resume durably;
- agent behavior is assembled through explicit lifecycle middleware;
- agents can delegate isolated work with narrower capabilities;
- prompts, skills, and orchestration policies are improved through reproducible
  evaluations;
- long-running work can iterate with fresh context and persistent artifacts.

The implementation remains native JavaScript and preserves Aperio's existing
provider loops, MCP tools, memory model, security controls, and SQLite/Postgres
backends. LangGraph and Deep Agents are references, not new runtime
dependencies.

## Non-goals

- Replacing Aperio's temporal/vector memory with Markdown files.
- Replacing the provider-specific loops in one migration.
- Giving autonomous agents unrestricted host shell access.
- Treating subagents as independent users with unrestricted access to the
  parent's state.
- Shipping self-modifying prompts or skills without evaluation and user review.
- Combining this work with unrelated refactors, translations, or documentation
  changes.

## Commit discipline

Before starting any slice:

1. `git status --short` must be clean.
2. Identify the exact source and test files expected to change.
3. Do not include drive-by formatting, generated files, or unrelated fixes.

The implementation assistant must not stage, commit, amend, reset, or push these
changes. Commit commands and final staging belong to the maintainer.

Before committing a slice:

1. Run the narrow tests for the changed subsystem.
2. Run syntax checks and `git diff --check`.
3. Inspect both `git diff` and `git diff --cached`.
4. Stage explicit paths; never use `git add -A` for this project.
5. Keep implementation and its direct tests in the same commit.
6. Leave broader UI, documentation, migration, and cleanup changes for their
   named slices.

Target two to six changed files per commit. A database slice may exceed this
when SQLite and Postgres migrations plus their direct tests must remain atomic.
If a slice grows beyond reviewable size, split it before committing.

Recommended commit prefixes:

- `feat(agent):`
- `feat(context):`
- `feat(security):`
- `feat(evals):`
- `test(agent):`
- `docs(agent):`

Do not push automatically. A clean local commit is the checkpoint; pushing
remains an explicit action.

## Architecture constraints

These constraints apply to every phase:

- Local Ollama remains fully supported, including small context windows.
- Cloud providers never receive self-memory or local-only content.
- Existing prompt-injection taint and confirm-before-write behavior cannot be
  weakened.
- Permissions are enforced by code at tool/backend boundaries, not only by
  prompts.
- A child agent may inherit or narrow permissions, never silently broaden them.
- Parent and child message histories remain isolated.
- Stored tool arguments and artifacts pass existing secret-redaction and file
  permission rules.
- New persisted data works on both SQLite and Postgres.
- All new background activity has time, iteration, concurrency, and cancellation
  limits.

## Phase 1 — Lossless tool-result offloading

Goal: preserve complete large tool results while sending only a bounded preview
to the model.

- [x] **1.1 Artifact store contract**
  - Add a session/run-scoped artifact-store module.
  - Store immutable content with ID, SHA-256 digest, byte count, media type,
    source tool, creation time, and owning session/run.
  - Use private filesystem permissions and atomic writes.
  - Tests: path safety, atomic write, digest stability, metadata, and cleanup.
  - Commit: `feat(context): add scoped artifact store`

- [x] **1.2 Tool-result offload policy**
  - Apply a configurable token/byte threshold after tool execution.
  - Replace oversized text with head/tail preview, omitted-size notice, artifact
    ID, and retrieval instructions.
  - Preserve non-text content blocks.
  - Keep the existing emergency trimmer as a final fallback.
  - Tests: small result unchanged, large result recoverable, mixed blocks,
    background run ownership, and secret redaction.
  - Commit: `feat(context): offload oversized tool results`

- [x] **1.3 Chunked artifact retrieval**
  - Add a read-only MCP tool that accepts artifact ID plus offset/limit.
  - Enforce session/run ownership and maximum response size.
  - Attach the tool only when an offloaded artifact exists in the current run.
  - Tests: pagination, invalid ID, cross-session denial, and end-of-content.
  - Commit: `feat(context): add chunked artifact retrieval`

- [x] **1.4 Lifecycle and observability**
  - Clean artifacts with their session/run retention policy.
  - Surface offload events and stored byte counts in logs/run history without
    logging content.
  - Document configuration and operational limits.
  - Commit: `feat(context): add artifact lifecycle observability`

Phase acceptance:

- [x] A result larger than the model context remains fully retrievable.
- [x] The model receives a bounded preview and can request only the needed chunks.
- [x] Resuming a retained session preserves its result artifacts.

Phase 1 completion record (2026-07-06):

- Session artifacts are removed on trivial-session discard, explicit deletion,
  and retention pruning; pinned sessions retain their artifacts.
- Background-run artifacts use the same `AGENT_RUN_RETENTION_DAYS` cutoff as
  run history. Unset or `0` preserves both indefinitely.
- Offload logs contain tool/artifact/scope/count metadata only. Background-run
  history stores aggregate artifact count and byte totals in SQLite/Postgres.
- `README.md` and `FEATURES.md` document thresholds, retrieval limits,
  retention behavior, and focused/manual verification steps.
- Focused Phase 1 lifecycle/database tests: 301 passed. Full suite: 2,687
  passed; three pre-existing WebSocket E2E tests timed out waiting for
  `session_created`.

## Phase 2 — Aperio lifecycle middleware

Goal: replace scattered orchestration conditionals with explicit, ordered
extension points without rewriting provider loops.

- [x] **2.1 Middleware runner and contract**
  - Introduce hooks for `beforeModel`, `selectTools`, `beforeTool`, `afterTool`,
    `afterModel`, `onInterrupt`, and `onError`.
  - Define ordering, short-circuiting, immutable request updates, and error
    semantics.
  - Tests cover ordering, async hooks, mutation isolation, and failures.
  - Commit: `feat(agent): add lifecycle middleware runner`

- [x] **2.2 Adapt tool safety hooks**
  - Move untrusted-content fencing, taint propagation, failure budgeting, and
    repeated-call detection behind middleware adapters.
  - Preserve existing emitted WebSocket events and behavior.
  - Commit: `feat(agent): route tool safety through middleware`

- [ ] **2.3 Adapt context and skill selection**
  - Route tool-profile selection, skill injection, memory pointers, result
    offloading, and context trimming through named middleware.
  - Keep provider serialization inside the provider adapters.
  - Commit: `feat(agent): compose context through middleware`

- [ ] **2.4 Middleware trace**
  - Record hook names, timing, decisions, and errors in a bounded per-run trace.
  - Never record secret arguments or full artifact contents.
  - Commit: `feat(agent): trace middleware decisions`

Phase acceptance:

- All current providers pass their existing loop tests.
- Existing safety behavior is unchanged or stricter.
- A new middleware can be registered without editing every provider loop.

Drill 2.1 completion record (2026-07-06):

- Added a provider-neutral runner with the seven named lifecycle hooks,
  registration-order execution, async handlers, immutable request snapshots,
  shallow returned updates, and explicit short-circuit results.
- Hook failures include hook/middleware identity. Every `onError` observer is
  notified in registration order, and observer failures cannot mask the
  originating failure.
- Registration rejects duplicate names, unknown fields, and invalid hook
  handlers. This drill establishes the contract only; routing existing tool,
  context, and provider behavior through it remains in drills 2.2 and 2.3.
- Focused agent/provider verification: 191 passed. Full suite: 2,693 passed and
  four contended WebSocket E2E cases timed out waiting for `session_created`;
  both affected files passed 15/15 when rerun together in isolation.

Drill 2.2 completion record (2026-07-06):

- Routed the shared tool execution boundary through named `beforeTool` and
  `afterTool` middleware for exhausted-budget gating, taint-to-write
  propagation, repeated-call detection, failure recording, and untrusted-result
  fencing.
- Preserved the existing three-failure budget, third-identical-call breaker,
  prompt-injection fences, `__tainted` confirmation signal, result-offload
  ordering, and WebSocket event names/payloads.
- Provider serialization and artifact/UI post-processing remain outside the
  safety adapters. Context, skill, and tool-profile composition remains drill
  2.3.
- Focused provider/security verification: 447 passed. Full suite: 2,696 passed
  and three contended WebSocket E2E cases timed out waiting for
  `session_created`; both affected files passed 15/15 in isolation.

## Phase 3 — Durable interrupts and resumable actions

Goal: pending sensitive operations survive process restart and support explicit
approve, edit, reject, and respond decisions.

- [ ] **3.1 Interrupt persistence**
  - Add SQLite/Postgres migrations and store APIs for pending interrupts.
  - Fields include ID, session/run, tool, canonical arguments or protected
    payload reference, digest, allowed decisions, status, timestamps, and
    expiry.
  - Never persist executable closures.
  - Commit: `feat(security): persist agent interrupts`

- [ ] **3.2 Interrupt service**
  - Create, list, expire, decide, and atomically claim interrupts.
  - Revalidate tool schema, permissions, taint, target state, and payload digest
    immediately before execution.
  - Make decisions idempotent and safe against replay.
  - Commit: `feat(security): add durable interrupt service`

- [ ] **3.3 Migrate file writes and deletes**
  - Replace in-memory write/delete token maps with durable descriptors.
  - Preserve capped diffs and current scratch-workspace behavior.
  - Commit: `feat(security): make file approvals resumable`

- [ ] **3.4 Migrate database writes**
  - Route `db_execute` through the same interrupt service.
  - Re-run statement classification and connection permissions at commit time.
  - Commit: `feat(security): make database approvals resumable`

- [ ] **3.5 API and UI decisions**
  - Present pending actions after reconnect.
  - Support approve, safe argument editing, reject with feedback, and respond
    without execution.
  - Show final status in session and background-run history.
  - Split API and UI into separate commits if either is not reviewable.
  - Commits:
    - `feat(security): expose durable interrupt API`
    - `feat(ui): add resumable action decisions`

Phase acceptance:

- A pending write remains pending across restart.
- The original action cannot execute twice.
- Editing arguments cannot bypass schema, path, or permission validation.

## Phase 4 — Agent specifications and permission narrowing

Goal: describe every chat, background, review, and delegated agent through one
validated runtime contract.

- [ ] **4.1 `AgentSpec` schema**
  - Define ID, description, model/provider override, identity/persona,
    character, skills, memory scopes, tool allowlist, filesystem rules,
    interrupt policy, timeout, recursion depth, concurrency, and output schema.
  - Reject unknown security-sensitive fields.
  - Commit: `feat(agent): define validated agent specifications`

- [ ] **4.2 Permission evaluator**
  - Use ordered, first-match rules for read, write, execute, network, database,
    and memory capabilities.
  - Implement parent-to-child narrowing and prove that widening is rejected.
  - Commit: `feat(security): add agent permission evaluator`

- [ ] **4.3 Apply specs to agent creation**
  - Make `createAgent` accept a normalized spec while preserving current call
    sites through a compatibility adapter.
  - Filter tool schemas before they reach any provider.
  - Commit: `feat(agent): construct agents from specifications`

- [ ] **4.4 Apply specs to background and round-table agents**
  - Replace ad hoc provider/persona/character options with stored specs.
  - Migrate existing job records safely.
  - Keep background jobs disabled by default.
  - Commits:
    - `feat(agent): apply specifications to background jobs`
    - `feat(agent): apply specifications to round tables`

- [ ] **4.5 Agent bundles**
  - Support an optional portable directory containing `AGENT.md`,
    `permissions.json`, agent-specific `skills/`, memory-scope configuration,
    and an output schema.
  - Bundles cannot override administrator-enforced policy.
  - Commit: `feat(agent): load portable agent bundles`

Phase acceptance:

- Existing chat and scheduled jobs behave identically under compatibility specs.
- Tests prove that a child cannot gain a tool or path denied to its parent.

## Phase 5 — Isolated task delegation

Goal: allow a capable parent agent to delegate bounded, context-heavy work and
receive one concise result.

- [ ] **5.1 Delegation runtime**
  - Launch a fresh agent with isolated messages, an explicit task description,
    parent cancellation, timeout, depth limit, and narrowed `AgentSpec`.
  - Return only the final result, structured response, artifact references, and
    bounded execution metadata.
  - Commit: `feat(agent): add isolated delegation runtime`

- [ ] **5.2 Internal `delegate_task` tool**
  - Expose available child types and their descriptions to capable models.
  - Keep orchestration in the main process rather than recursively hiding it
    behind the MCP subprocess.
  - Reject trivial recursion, unknown types, excessive depth, and unsafe
    permission requests.
  - Commit: `feat(agent): expose bounded task delegation`

- [ ] **5.3 Structured child output**
  - Validate optional JSON Schema output.
  - Return a clear error when structured output is invalid; never silently treat
    malformed JSON as trusted state.
  - Commit: `feat(agent): validate delegated task results`

- [ ] **5.4 Parallelism and UI**
  - Add a small configurable concurrency pool for independent child tasks.
  - Stream lifecycle events, not hidden reasoning.
  - Show child status, model, duration, tools, artifacts, and final result.
  - Split runtime and UI commits.
  - Commits:
    - `feat(agent): bound parallel task delegation`
    - `feat(ui): show delegated task activity`

Phase acceptance:

- Parent and child histories do not leak into one another.
- Cancellation stops descendants.
- A delegated research or code-analysis task consumes only its compact result in
  the parent context.

## Phase 6 — Explicit planning for long tasks

Goal: provide visible progress tracking without forcing plans onto simple chat.

- [ ] **6.1 Run-scoped task plan**
  - Add `write_plan`/`update_plan` operations with pending, active, completed,
    and blocked states.
  - Permit at most one active item unless the plan explicitly marks parallel
    branches.
  - Persist the plan with session/run state, not long-term user memory.
  - Commit: `feat(agent): add run-scoped task planning`

- [ ] **6.2 Selective activation**
  - Attach planning only for multi-step capable-model profiles, delegated tasks,
    and iterative background work.
  - Do not expose it for greetings, simple lookups, or weak/toolless models.
  - Commit: `feat(agent): activate planning selectively`

- [ ] **6.3 Progress UI**
  - Render plan state in chat and background-run views.
  - Keep plan events out of the conversational transcript unless needed for
    resume.
  - Commit: `feat(ui): show agent task progress`

Phase acceptance:

- Plans survive resume.
- Simple conversations incur no plan-tool or prompt overhead.

## Phase 7 — Evaluation-driven harness improvement

Goal: measure prompt, skill, tool-profile, and middleware changes before keeping
them.

- [ ] **7.1 Executable evaluation cases**
  - Convert the capability exam and evaluation scorecards into machine-readable
    cases with fixtures and deterministic assertions where possible.
  - Divide cases into visible train and protected holdout sets.
  - Commit: `feat(evals): add executable agent evaluation cases`

- [ ] **7.2 Local evaluation runner**
  - Capture answer, tool sequence, artifacts, interrupts, latency, token use,
    and policy violations.
  - Support provider/model matrices without requiring cloud services.
  - Commit: `feat(evals): add local harness evaluation runner`

- [ ] **7.3 Candidate workspace**
  - Allow proposed changes only to explicitly listed prompts, skills,
    tool-profile configuration, or middleware registration.
  - Apply candidates in a temporary workspace.
  - Never modify the working tree during evaluation.
  - Commit: `feat(evals): isolate harness candidates`

- [ ] **7.4 Keep/discard gate**
  - Run baseline and candidate on train and holdout.
  - Keep a candidate only when the configured score improves without new safety
    regressions.
  - Produce a reviewable patch and score report; do not auto-commit.
  - Commit: `feat(evals): gate harness changes on holdout results`

Phase acceptance:

- Re-running a fixed local-model evaluation produces a comparable report.
- Candidate changes cannot escape their declared surfaces.
- Safety failures veto an otherwise higher aggregate score.

## Phase 8 — Bounded fresh-context iteration

Goal: support long-running tasks where each iteration starts with clean model
context while artifacts and explicit progress persist.

- [ ] **8.1 Iterative background-run mode**
  - Add task, work directory, maximum iterations, per-iteration timeout, total
    budget, model/spec, and completion-check configuration.
  - Each iteration receives the objective, current plan, artifact index, last
    verdict, and a bounded progress note—not the full previous conversation.
  - Commit: `feat(agent): add fresh-context iterative runs`

- [ ] **8.2 Checkpoint and completion protocol**
  - Persist iteration number, plan, artifacts, file digest manifest, result,
    errors, and completion verdict.
  - Stop on success, repeated no-progress state, budget exhaustion, cancellation,
    or pending interrupt.
  - Commit: `feat(agent): checkpoint iterative run progress`

- [ ] **8.3 Safety and recovery**
  - Require narrowed permissions and explicit shell policy.
  - Resume safely after restart without repeating a committed sensitive action.
  - Add loop/no-progress detection and a hard concurrency cap.
  - Commit: `feat(security): bound iterative agent execution`

- [ ] **8.4 Run controls and history**
  - Add start, pause, resume, cancel, and inspect controls.
  - Show each iteration's compact verdict and artifact changes.
  - Split API and UI commits.
  - Commits:
    - `feat(agent): expose iterative run controls`
    - `feat(ui): show iterative run history`

Phase acceptance:

- A multi-iteration task stays within its configured limits.
- Restart and resume do not lose artifacts or duplicate approved operations.
- Every iteration is inspectable without storing hidden reasoning.

## Phase 9 — Memory scopes and learned procedures

Goal: make Aperio's existing memory categories explicit across agent types
without weakening the current privacy boundary.

- [ ] **9.1 Explicit memory classification**
  - Represent semantic facts, episodic run records, and procedural skills as
    distinct types with clear retrieval policy.
  - Preserve temporal history and existing user/self separation.
  - Commit: `feat(memory): classify agent memory roles`

- [ ] **9.2 Scope policy**
  - Support user, agent, and shared/system scopes.
  - Shared/system policy is read-only to agents by default.
  - Cloud providers continue to exclude self and local-only scopes.
  - Commit: `feat(memory): enforce agent memory scopes`

- [ ] **9.3 Background consolidation proposals**
  - Derive proposed lessons from successful and failed runs.
  - Present memory or skill changes for review with provenance to source runs.
  - Never modify bundled skills automatically.
  - Commit: `feat(memory): propose lessons from agent runs`

Phase acceptance:

- A memory query cannot cross a denied scope.
- Every learned procedure links back to evidence and requires review before
  activation.

## Cross-phase release gates

Run these gates at the end of every phase, in a dedicated fix commit only if the
phase's final slice cannot contain the correction cleanly:

- [ ] Narrow subsystem tests pass.
- [ ] Full `npm test` result is recorded and regressions are resolved.
- [ ] `npm run i18n:check` passes when UI strings changed.
- [ ] `npm run gen:env:check` passes when configuration changed.
- [ ] SQLite and Postgres behavior is covered where persistence changed.
- [ ] Local Ollama smoke test passes for changed agent behavior.
- [ ] At least one cloud/CLI-backed provider contract test passes.
- [ ] Secret redaction, path restrictions, taint, and confirmation tests pass.
- [ ] `git diff --check` passes and the worktree is clean after commit.
- [ ] `FEATURES.md` and user documentation are updated only for shipped behavior.

## Phase verification notes

When a phase is completed, add a short developer handoff here if manual testing
or operational inspection would catch problems that automated tests cannot.
Keep it practical: commands to run, one or two smoke scenarios, expected
artifacts/events, and known limitations. Omit the note when it would only repeat
the automated acceptance checks.

### Phase 1

For a retained chat, force a low offload threshold, page the result through
`read_artifact`, restart Aperio, and confirm the same artifact remains readable.
Deleting the chat should remove its session artifact directory. Background-run
artifact retention follows `AGENT_RUN_RETENTION_DAYS`.

## Progress log

Add one line after each completed slice. The progress-log update belongs in that
slice's commit, so the plan and code cannot drift.

| Date | Slice | Commit | Verification | Notes |
|---|---|---|---|---|
| 2026-07-06 | Plan created | `docs(agent): add orchestration implementation plan` | `git diff --check` | Initial roadmap |
| 2026-07-06 | 1.1 Artifact store contract | `feat(context): add scoped artifact store` | 92 focused pass; full 2668/2671; 3 contended E2E cases pass 15/15 in isolation; syntax; diff check | Private immutable session/run storage |
| 2026-07-06 | 1.2 Tool-result offload policy | maintainer commit pending | 163 focused pass; full 2678/2681; 3 contended E2E cases pass 15/15 in isolation; syntax; config generation; diff check | Full redacted result retained; bounded preview enters model context |
| 2026-07-06 | 2.1 Middleware runner and contract | `aab6b17` | 191 focused pass; full 2693/2697; 4 contended E2E cases pass 15/15 in isolation; syntax; diff check | Provider-neutral ordered hooks; provider routing begins in 2.2 |
| 2026-07-06 | 2.2 Tool safety adapters | maintainer commit pending | 447 focused pass; full 2696/2699; 3 contended E2E cases pass 15/15 in isolation; syntax; diff check | Existing tool safety now runs through named lifecycle middleware |

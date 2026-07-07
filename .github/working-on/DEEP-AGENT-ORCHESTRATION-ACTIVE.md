# Active Agent Orchestration Roadmap

Read this with `DEEP-AGENT-ORCHESTRATION-PLAN.md` when continuing the work.
Completed historical detail lives in
`DEEP-AGENT-ORCHESTRATION-COMPLETED.md`.

## Phase 4 — Agent Specifications And Permission Narrowing

Goal: describe every chat, background, review, and delegated agent through one
validated runtime contract.

- [x] **4.1 `AgentSpec` schema**
  - Define ID, description, model/provider override, identity/persona,
    character, skills, memory scopes, tool allowlist, filesystem rules,
    interrupt policy, timeout, recursion depth, concurrency, and output schema.
  - Reject unknown security-sensitive fields.
  - Commit: `feat(agent): define validated agent specifications`

- [x] **4.2 Permission evaluator**
  - Use ordered, first-match rules for read, write, execute, network, database,
    and memory capabilities.
  - Implement parent-to-child narrowing and prove that widening is rejected.
  - Commit: `feat(security): add agent permission evaluator`

- [x] **4.3 Apply specs to agent creation**
  - Make `createAgent` accept a normalized spec while preserving current call
    sites through a compatibility adapter.
  - Filter tool schemas before they reach any provider.
  - Commit: `feat(agent): construct agents from specifications`

- [x] **4.4 Apply specs to background and round-table agents**
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

## Phase 5 — Isolated Task Delegation

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

## Phase 6 — Explicit Planning For Long Tasks

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

## Phase 7 — Evaluation-Driven Harness Improvement

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

## Phase 8 — Bounded Fresh-Context Iteration

Goal: support long-running tasks where each iteration starts with clean model
context while artifacts and explicit progress persist.

- [ ] **8.1 Iterative background-run mode**
  - Add task, work directory, maximum iterations, per-iteration timeout, total
    budget, model/spec, and completion-check configuration.
  - Each iteration receives the objective, current plan, artifact index, last
    verdict, and a bounded progress note, not the full previous conversation.
  - Commit: `feat(agent): add fresh-context iterative runs`

- [ ] **8.2 Checkpoint and completion protocol**
  - Persist iteration number, plan, artifacts, file digest manifest, result,
    errors, and completion verdict.
  - Stop on success, repeated no-progress state, budget exhaustion,
    cancellation, or pending interrupt.
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

- A multi-iteration task stays within configured limits.
- Restart and resume do not lose artifacts or duplicate approved operations.
- Every iteration is inspectable without storing hidden reasoning.

## Phase 9 — Memory Scopes And Learned Procedures

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

## Cross-Phase Release Gates

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
- [ ] `FEATURES.md` and user documentation are updated only for shipped
  behavior.

## Progress Log

Add one line after each completed slice. The progress-log update belongs in
that slice's commit, so plan and code cannot drift.

| Date | Slice | Commit | Verification | Notes |
|---|---|---|---|---|
| 2026-07-06 | Plan created | `docs(agent): add orchestration implementation plan` | `git diff --check` | Initial roadmap |
| 2026-07-06 | 1.1 Artifact store contract | `feat(context): add scoped artifact store` | 92 focused pass; full 2668/2671; 3 contended E2E cases pass 15/15 in isolation; syntax; diff check | Private immutable session/run storage |
| 2026-07-06 | 1.2 Tool-result offload policy | maintainer commit pending | 163 focused pass; full 2678/2681; 3 contended E2E cases pass 15/15 in isolation; syntax; config generation; diff check | Full redacted result retained; bounded preview enters model context |
| 2026-07-06 | 2.1 Middleware runner and contract | `aab6b17` | 191 focused pass; full 2693/2697; 4 contended E2E cases pass 15/15 in isolation; syntax; diff check | Provider-neutral ordered hooks; provider routing begins in 2.2 |
| 2026-07-06 | 2.2 Tool safety adapters | `934c794` | 447 focused pass; full 2696/2699; 3 contended E2E cases pass 15/15 in isolation; syntax; diff check | Existing tool safety now runs through named lifecycle middleware |
| 2026-07-06 | 2.3 Context and skill middleware | `346701d`, `a17e166` | 320 focused pass; full 2700/2703; 3 contended E2E cases pass 15/15 in isolation; syntax; diff check | Canonical context composition with provider-local serialization |
| 2026-07-06 | 2.4 Middleware trace | maintainer commit pending | 577 focused pass; full 2703/2706; affected E2E 14/15 together, remaining case passes alone; syntax; diff check | Bounded metadata-only per-run lifecycle diagnostics |
| 2026-07-07 | 3.5 API and UI decisions | current commit | API, WebSocket, interrupt-service, file-confirmation, and database-confirmation tests pass; syntax; diff check | Durable decisions exposed through API/UI and run history |
| 2026-07-07 | 4.1 AgentSpec schema | current commit | `NODE_ENV=test node --test tests/lib/agent/spec.test.js`; `node --check lib/agent/spec.js` | Validated normalized spec contract with provider/model, identity/persona, character, skills, memory scopes, tool allowlist, filesystem rules, interrupt policy, limits, and output schema |
| 2026-07-07 | 4.2 Permission evaluator | current commit | `NODE_ENV=test node --test tests/lib/security/agentPermissions.test.js`; `node --check lib/security/agentPermissions.js` | Ordered first-match permission policy for read/write/execute/network/database/memory plus conservative parent-to-child narrowing checks |
| 2026-07-07 | 4.3 Apply specs to agent creation | current commit | `NODE_ENV=test node --test tests/lib/agent.test.js tests/lib/agent/spec.test.js tests/lib/security/agentPermissions.test.js`; `node --check lib/agent/index.js` | `createAgent` accepts normalized specs, preserves legacy calls through compatibility specs, applies provider/persona/character/identity prompt overrides, and filters provider-visible tool schemas by explicit allowlist |
| 2026-07-07 | 4.4 Background and round-table specs | current commit | `NODE_ENV=test node --test tests/lib/workers/agent-scheduler.test.js tests/db/sqlite.test.js tests/db/postgres.test.js tests/lib/routes/api.test.js`; syntax checks; `git diff --check` | Freeform background jobs now persist validated specs with legacy provider/persona/character normalization; round-table agents are constructed from specs derived from existing configuration |

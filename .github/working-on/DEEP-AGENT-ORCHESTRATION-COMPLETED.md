# Completed Agent Orchestration Phases

This archive preserves historical context for completed work. Do not feed it to
an implementation agent unless the current task needs details from Phases 1-3.

## Phase 1 — Lossless Tool-Result Offloading

Goal: preserve complete large tool results while sending only a bounded preview
to the model.

Completed slices:

- [x] **1.1 Artifact store contract** — scoped immutable artifact store with
  private filesystem permissions, atomic writes, SHA-256 metadata, and cleanup
  tests.
- [x] **1.2 Tool-result offload policy** — configurable byte/token threshold,
  bounded head/tail previews, recovery instructions, mixed-block preservation,
  and secret-redacted storage.
- [x] **1.3 Chunked artifact retrieval** — read-only `read_artifact` MCP tool
  with ownership checks, pagination, and response caps.
- [x] **1.4 Lifecycle and observability** — session/run retention cleanup plus
  metadata-only logs and run-history artifact counts.

Acceptance:

- [x] A result larger than model context remains fully retrievable.
- [x] The model receives a bounded preview and can request only needed chunks.
- [x] Resuming a retained session preserves result artifacts.

Completion record (2026-07-06):

- Session artifacts are removed on trivial-session discard, explicit deletion,
  and retention pruning; pinned sessions retain artifacts.
- Background-run artifacts use the same `AGENT_RUN_RETENTION_DAYS` cutoff as
  run history. Unset or `0` preserves both indefinitely.
- Offload logs contain tool/artifact/scope/count metadata only. Background-run
  history stores aggregate artifact count and byte totals in SQLite/Postgres.
- `README.md` and `FEATURES.md` document thresholds, retrieval limits,
  retention behavior, and focused/manual verification steps.
- Focused Phase 1 lifecycle/database tests: 301 passed. Full suite: 2,687
  passed; three pre-existing WebSocket E2E tests timed out waiting for
  `session_created`.

Manual verification note:

For a retained chat, force a low offload threshold, page the result through
`read_artifact`, restart Aperio, and confirm the same artifact remains readable.
Deleting the chat should remove its session artifact directory. Background-run
artifact retention follows `AGENT_RUN_RETENTION_DAYS`.

## Phase 2 — Aperio Lifecycle Middleware

Goal: replace scattered orchestration conditionals with explicit, ordered
extension points without rewriting provider loops.

Completed slices:

- [x] **2.1 Middleware runner and contract** — hooks for `beforeModel`,
  `selectTools`, `beforeTool`, `afterTool`, `afterModel`, `onInterrupt`, and
  `onError` with ordering, short-circuiting, immutable request snapshots, and
  failure semantics.
- [x] **2.2 Tool safety adapters** — untrusted-content fencing, taint
  propagation, failure budgeting, and repeated-call detection behind
  middleware.
- [x] **2.3 Context and skill selection** — tool-profile selection, skill
  injection, memory pointers, result offloading, and context trimming through
  named middleware.
- [x] **2.4 Middleware trace** — bounded per-run trace with hook names, timing,
  decisions, and error class only.

Acceptance:

- [x] All current providers pass existing loop tests.
- [x] Existing safety behavior is unchanged or stricter.
- [x] A new middleware can be registered without editing every provider loop.

Drill 2.1 completion record (2026-07-06):

- Added a provider-neutral runner with the seven named lifecycle hooks,
  registration-order execution, async handlers, immutable request snapshots,
  shallow returned updates, and explicit short-circuit results.
- Hook failures include hook/middleware identity. Every `onError` observer is
  notified in registration order, and observer failures cannot mask the
  originating failure.
- Registration rejects duplicate names, unknown fields, and invalid hook
  handlers. This drill established the contract only; routing existing tool,
  context, and provider behavior through it remained for drills 2.2 and 2.3.
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
  safety adapters. Context, skill, and tool-profile composition remained drill
  2.3.
- Focused provider/security verification: 447 passed. Full suite: 2,696 passed
  and three contended WebSocket E2E cases timed out waiting for
  `session_created`; both affected files passed 15/15 in isolation.

Drill 2.3 completion record (2026-07-06):

- Added named middleware for context trimming, memory pointers, skill injection,
  tool-profile selection, and lossless tool-result offloading.
- Anthropic, Ollama, Gemini, and DeepSeek loops now consume one canonical
  prepared context and retain only provider-specific message/tool wire
  serialization. Claude Code and Codex continue using SDK/CLI-managed context
  paths.
- Preserved the 20-message fallback window, token-pressure events, orphaned
  tool-result cleanup, local-only self tools/memory, skill events,
  small-window tool caps, artifact-read activation, and offload fail-open
  behavior.
- Focused agent/context verification: 320 passed. Full suite: 2,700 passed and
  three contended WebSocket E2E cases timed out waiting for `session_created`;
  both affected files passed 15/15 in isolation.

Drill 2.4 completion record (2026-07-06):

- Added a per-run lifecycle trace shared by context, tool-safety, and result
  offload runners. Runtime traces retain at most 200 entries.
- Entries contain only sequence, relative/duration milliseconds, hook,
  middleware, decision, and optional error class. Requests, prompts, arguments,
  results, exception messages, and artifact content cannot enter the trace
  record contract.
- Trace writes fail open and cannot change middleware behavior. The agent
  exposes a read-only snapshot of the last-started run for diagnostics.
- Focused trace/provider/security verification: 577 passed. Full suite: 2,703
  passed and three contended WebSocket E2E cases timed out waiting for
  `session_created`. The two affected files then passed 14/15 together; the one
  remaining intermittent lifecycle case passed alone.

Manual verification note:

Run lifecycle, context, safety, and provider suites, then inspect
`agent.getLifecycleTrace()` after a tool-using turn. Expect ordered metadata
entries only; no prompt text, tool arguments/results, error messages, or
artifact contents should appear. The trace is in-memory, bounded to the most
recent 200 events, and replaced when the next run starts.

## Phase 3 — Durable Interrupts And Resumable Actions

Goal: pending sensitive operations survive process restart and support explicit
approve, edit, reject, and respond decisions.

Completed slices:

- [x] **3.1 Interrupt persistence** — SQLite/Postgres migrations and store APIs
  for pending interrupt descriptors.
- [x] **3.2 Interrupt service** — create, list, expire, decide, atomically
  claim, complete, and execute through revalidation callbacks.
- [x] **3.3 Migrate file writes and deletes** — durable descriptors for
  `write_file`, `append_file`, `edit_file`, and `delete_file`.
- [x] **3.4 Migrate database writes** — `db_execute` through the same durable
  interrupt service with commit-time SQL and connection checks.
- [x] **3.5 API and UI decisions** — pending-action API/UI with approve, edit,
  reject, and respond decisions plus run-history status.

Acceptance:

- [x] A pending write remains pending across restart.
- [x] The original action cannot execute twice.
- [x] Editing arguments cannot bypass schema, path, or permission validation.

Drill 3.1 completion record (2026-07-07):

- Added SQLite and Postgres `agent_interrupts` migrations for durable pending
  sensitive-action descriptors scoped to sessions and/or background runs.
- Persisted tool name, canonical arguments or protected payload reference,
  digest, allowed decisions, status, timestamps, and expiry without executable
  closures.
- Added low-level store APIs to create, get, list, and status-update interrupt
  descriptors on both backends. Pending lists filter expired rows by default and
  cap result size.
- Kept interrupt descriptors off the public DB-browser whitelist because they
  are internal security metadata.
- Focused interrupt verification passed for SQLite and Postgres. Full mocked
  Postgres DB suite passed. Fresh SQLite and Postgres stores now seed the
  baseline maintenance job disabled by default.

Drill 3.2 completion record (2026-07-07):

- Added a durable interrupt service with create, list, expire, decide, claim,
  complete, and claim-and-execute operations.
- Decisions support approve, edit, reject, and respond. Replays are idempotent
  only when the same decision payload is repeated; conflicting later decisions
  are rejected.
- Execution requires an atomic store claim from approved/edited state. Claimed
  or completed interrupts cannot execute again.
- The service revalidates descriptors on creation, decision, and immediately
  before claim/execution through an injected policy callback.
- Digest generation is canonical and stable across object key ordering.
  Approved payloads are checked again before execution; edited payloads must
  pass revalidation before they can be claimed.
- Focused service, SQLite interrupt, and Postgres interrupt verification passed.
  Full mocked Postgres DB suite passed. Syntax checks and `git diff --check`
  passed.

Drill 3.3 completion record (2026-07-07):

- Migrated `write_file`, `append_file`, `edit_file`, and `delete_file`
  confirmation tokens from in-memory closure maps to durable interrupt
  descriptors. Existing `wr_...` and `del_...` token UX is preserved.
- File descriptors store JSON-reconstructable operation arguments, target paths,
  proposal-time SHA-256 target-state digests, allowed decisions, expiry, and
  session/run scope. They do not persist executable closures.
- Confirm execution now approves, atomically claims, executes, and completes via
  the interrupt service. Replays cannot execute the same descriptor twice.
- Confirm-time revalidation re-checks write permissions, secret-file/type
  guards, and target-state digest before executing stale edits/appends/deletes.
- Capped edit diffs, tainted-turn confirmation, and frictionless clean writes
  inside `var/scratch/` are preserved.
- Focused file-tool verification passed. Shared interrupt service, Postgres DB,
  and SQLite interrupt checks passed.

Drill 3.4 completion record (2026-07-07):

- Migrated `db_execute` from an in-memory confirmation closure map to durable
  interrupt descriptors using the same service as file write/delete approvals.
- Database descriptors store only JSON-reconstructable connection name,
  normalized single SQL statement, bound params, statement class, keyword, and
  engine metadata. They do not persist executable closures or connection
  secrets.
- Confirm execution now approves, atomically claims, executes, and completes via
  the interrupt service. Replays cannot execute the same database descriptor
  twice.
- Commit-time revalidation re-runs SQL classification and checks that the named
  connection still exists and is writable; changing a connection to read-only
  before confirmation prevents execution.
- Restored the disabled `nightly-maintenance` baseline job seed for fresh
  SQLite/Postgres stores, resolving the previously documented broader SQLite DB
  seed failures.
- Focused database confirmation, SQLite DB, and Postgres DB verification passed.

Drill 3.5 completion record (2026-07-07):

- Added `/api/interrupts` to list pending durable sensitive-action descriptors
  in a normalized API shape and `/api/interrupts/:id/decision` for approve,
  edit, reject, and respond decisions.
- Routed approve/edit execution for file write/append/edit/delete and
  `db_execute` through the existing durable service helpers, so commit-time
  path, target-state, SQL classification, connection writability, digest, claim,
  and completion validation remain the execution path.
- Preserved the legacy `confirm_action` WebSocket token behavior for
  non-durable callers while using the durable API path when a descriptor exists.
- The chat UI now renders pending durable actions after reconnect and supports
  approve, JSON argument editing, reject with optional feedback, and respond
  without execution. Final decision status is pushed back over WebSocket and the
  pending-action cards are refreshed. Background-agent run history now includes
  compact sensitive-action status rows for runs with associated interrupts.
- Focused API, WebSocket, interrupt-service, file-confirmation, and
  database-confirmation verification passed.

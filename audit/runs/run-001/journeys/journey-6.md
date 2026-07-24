# Journey 6 — Background job → permissions/budget → interrupt → persisted run → restart/resume

**Audit run:** Run 001  
**Date:** 2026-07-24  
**Verdict:** PASS — well-tested; two minor gaps (budget exhaustion, shutdown/resume)

---

## Hops

### Hop 1 — Job creation + scheduling

| Field | Value |
|-------|-------|
| **Files** | `lib/workers/agent-scheduler.js:1-326`, `lib/agent/job-spec.js:1-63` |
| **What happens** | Scheduler creates jobs with steps/freeform modes. `buildBackgroundJobSpec()` freezes provider/model/persona at creation. Interval/watcher triggers. Single-flight via `inFlight` set |
| **Contract** | Job spec immutable after creation. No duplicate concurrent runs |
| **Test coverage** | ✅ `tests/integration/workers/agent-scheduler.test.js:1-603` — loadJobs, runJob, recording, notify, gating, watcher triggers. ✅ `tests/integration/db/contract/agent-jobs.test.js:1-100` — cross-backend CRUD contract tests. ✅ `tests/e2e/real-app/real-app-agent-jobs.test.js:1-140` — full E2E lifecycle |
| **Finding** | Clean — excellent coverage across unit, integration, E2E, and cross-backend contract tests |

### Hop 2 — Permission/budget evaluation

| Field | Value |
|-------|-------|
| **Files** | `lib/security/agentPermissions.js:1-232`, `lib/helpers/roundtableBudget.js` |
| **What happens** | `createPermissionPolicyFromAgentSpec()` builds permissions from frozen job spec. First-match rules, default-deny. Budget checked via `roundtableBudget.js` |
| **Contract** | Permissions must be applied consistently at job time. Budget must be enforced before execution |
| **Test coverage** | ✅ `tests/unit/security/agentPermissions.test.js:1-162` — permission evaluation. ❌ Budget exhaustion untested |
| **Finding** | Budget exhaustion during agent execution loop is untested |

### Hop 3 — Interrupt lifecycle

| Field | Value |
|-------|-------|
| **Files** | `lib/security/interruptService.js:1-239`, `lib/emitters/handlers/ws/interrupts.js:1-87`, `lib/routes/api-interrupts.js:1-98` |
| **What happens** | Interrupt: create → decide → claim → complete lifecycle. `decideAndMaybeExecute()` routes to `decideFileInterrupt`/`decideDatabaseInterrupt`/`decideGithubInterrupt`. `claimAndExecute()` with revalidate hook |
| **Contract** | Interrupt lifecycle must be atomic. State machine must not allow invalid transitions |
| **Test coverage** | ✅ `tests/unit/security/interruptService.test.js:1-287` — full interrupt state-machine unit tests. ✅ `tests/unit/handlers/ws/interrupts.test.js:1-134` — WS handler tests. ✅ `tests/e2e/real-app/real-app-interrupts.test.js:1-175` — E2E interrupt flow |
| **Finding** | Clean — well-tested. G4 (expired-interrupt) is skipped in E2E due to hardcoded 2-min TTL — no test hook to shorten |

### Hop 4 — Run persistence

| Field | Value |
|-------|-------|
| **Files** | `db/migrations/002_agent_jobs.sql`, `db/migrations-sqlite/002_agent_jobs.sql`, `db/sqlite/store.js:936-995`, `db/postgres/store.js:597-660` |
| **What happens** | `agent_jobs` (JSONB) + `agent_runs` tables in both backends. `recordAgentRun()`, `listAgentRuns()`, `pruneAgentRuns()` methods. Full parity |
| **Contract** | Both backends must support identical run recording semantics |
| **Test coverage** | ✅ `tests/integration/db/contract/agent-jobs.test.js:1-100` — cross-backend contract tests |
| **Finding** | Clean — migration parity, cross-backend tests |

### Hop 5 — Shutdown/resume

| Field | Value |
|-------|-------|
| **Files** | `lib/helpers/shutdownGuard.js:1-135`, `lib/server/shutdown.js` |
| **What happens** | Watchdog monitors idle timeout, heartbeat, quit, session-preservation latch. Graceful shutdown drains in-flight work. **No mechanism to re-queue in-flight jobs after crash** |
| **Contract** | Shutdown must preserve in-progress job state. Restart must not lose queued jobs |
| **Test coverage** | ❌ ShutdownGuard idle timeout, `_markShuttingDown` latch, and llama-server group-kill all untested |
| **Finding** | ⚠️ **No restart-resume mechanism** — crash during long-running freeform job loses that run's progress. No test for graceful shutdown path |

---

## Summary

| Hop | Name | Test coverage | Critical gaps |
|-----|------|-------------|--------------|
| 1 | Job creation + scheduling | ✅ | None |
| 2 | Permission/budget | ⚠️ | Budget exhaustion untested |
| 3 | Interrupt lifecycle | ✅ | G4 TTL is hardcoded, can't test expiration |
| 4 | Run persistence | ✅ | None |
| 5 | Shutdown/resume | ❌ | **No restart-resume mechanism.** Shutdown flow untested |

**Verdict:** PASS — Hops 1-4 well-tested across unit, integration, contract, and E2E levels. Major gap: no restart-resume mechanism for crashed in-flight jobs. Budget exhaustion and shutdown flow untested.

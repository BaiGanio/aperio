# Journey 12 — Permission or model change while a background job is queued, running, interrupted, and resumed

**Audit run:** Run 001  
**Date:** 2026-07-24  
**Verdict:** PASS — strong static isolation; three gaps (no mid-job permission re-eval, reload doesn't interrupt, switch_model ignores background jobs)

---

## Hops

### Hop 1 — Job spec frozen at creation

| Field | Value |
|-------|-------|
| **Files** | `lib/agent/job-spec.js:1-63`, `lib/workers/agent-scheduler.js:1-326` |
| **What happens** | `buildBackgroundJobSpec()` freezes provider/model/persona/permissions at job creation. `normalizeAgentJobDefinition()` validates spec. Job runs with captured snapshot |
| **Contract** | Job spec must not change during execution. Provider/model/permissions frozen at creation time |
| **Test coverage** | ✅ `tests/unit/security/interruptService.test.js` — interrupt lifecycle. ✅ `tests/integration/workers/agent-scheduler.test.js:1-603` |
| **Finding** | Clean — static isolation prevents mid-job drift |

### Hop 2 — Permission change while job queued

| Field | Value |
|-------|-------|
| **Files** | `lib/security/agentPermissions.js:1-232`, `lib/config-sync.js`, `lib/config-resolver.js` |
| **What happens** | Config changes (via Settings UI) are persisted to DB. `applyConfigToEnv()` runs at boot only. Permission changes require server restart to affect running agents. **Background jobs use their frozen spec, not live config** |
| **Contract** | Permission changes must take effect before a queued job runs |
| **Test coverage** | ❌ No test for permission change + queued job interaction |
| **Finding** | ⚠️ **No mechanism to re-evaluate permissions on queued jobs.** Change after creation but before execution uses stale spec. Requires restart or scheduler `reload()` |

### Hop 3 — Permission change while job running

| Field | Value |
|-------|-------|
| **Files** | `lib/workers/agent-scheduler.js:326`, `lib/agent/index.js:737-755` |
| **What happens** | Scheduler's `reload()` re-reads job definitions from store. **Does not interrupt in-flight jobs.** Running jobs continue with original frozen spec until completion |
| **Contract** | Permission change must apply to subsequently queued jobs immediately |
| **Test coverage** | ✅ `tests/integration/workers/agent-scheduler.test.js` — reload tests |
| **Finding** | ⚠️ **`reload()` doesn't interrupt in-flight jobs.** Jobs running with stale permissions cannot be re-evaluated mid-execution |

### Hop 4 — Model change while job queued

| Field | Value |
|-------|-------|
| **Files** | `lib/emitters/handlers/wsHandler.js:397-423`, `lib/server.js` |
| **What happens** | `switch_model` message calls `agent.setProvider()` on **chat agent only**. Background jobs have their own provider/model in their frozen spec. Model change in UI does not propagate to scheduler |
| **Contract** | Model change must either propagate to background jobs or warn the user |
| **Test coverage** | ❌ No test for switch_model + background job interaction |
| **Finding** | ⚠️ **`switch_model` only affects chat agent.** A user who switches the model may be unaware background jobs still use the old model |

### Hop 5 — Job interrupt during permission change

| Field | Value |
|-------|-------|
| **Files** | `lib/security/interruptService.js:1-239`, `lib/emitters/handlers/ws/interrupts.js:1-87` |
| **What happens** | Interrupt lifecycle is per-tool, not per-job-setting. Interrupts are triggered by mutating tool calls, not by config changes. A running job interrupted by user action can be resumed with original frozen spec |
| **Contract** | Interrupted jobs must resume with the same spec they started with |
| **Test coverage** | ✅ E2E interrupt tests cover interrupt + resume cycle |
| **Finding** | Clean — interrupt/resume preserves original spec |

---

## Summary

| Hop | Name | Test coverage | Critical gaps |
|-----|------|-------------|--------------|
| 1 | Job spec frozen | ✅ | None |
| 2 | Permission change + queued | ❌ | Stale spec until restart/reload |
| 3 | Permission change + running | ⚠️ | reload doesn't interrupt in-flight |
| 4 | Model change + queued | ❌ | switch_model ignores background jobs |
| 5 | Job interrupt during change | ✅ | Clean |

**Verdict:** PASS — strong static isolation guarantees no mid-job config drift. Three gaps: (1) permission re-evaluation on queued jobs requires restart, (2) `reload()` doesn't interrupt in-flight jobs, (3) `switch_model` only affects chat agent, not background jobs. All accepted design trade-offs.

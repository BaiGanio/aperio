# Audit Protocol — Outstanding Items (2026-06-23)

This file captures items surfaced by re-running the audit protocol against the
current codebase (version `0.65.0`). The original `audit-protocol.md` was a
snapshot from an earlier version (`0.48.3`–`0.56.0` range); most of its
findings have been addressed. What remains is below.

---

## 1. SECURITY.md version drift (documentation bug)

**Severity:** Low  
**Status:** Not started  
**File:** `SECURITY.md` line ~31

`package.json` reports version `0.65.0`, but `SECURITY.md` still lists `0.56.x`
as current stable:

```markdown
| 0.56.x   | ✅ Yes    | Current stable — fully supported |
```

This is a documentation drift — the security policy's supported-version table
needs to match `package.json`. A security researcher or user reading
`SECURITY.md` should know which actual release line is supported.

**Proposed fix:** Bump the supported-version row to `0.65.x` (or whatever the
current stable release line is) and add a row for the previous line with
end-of-life date.

---

## 2. Read/write path scopes are still unified

**Severity:** Low (informational)  
**Status:** Observation — may be intentional  
**Files:** `lib/routes/paths.js`, `.env`

The original audit asked: "Are read and write scopes still unified, or have
they been split?"

They are still unified. `APERIO_ALLOWED_PATHS_TO_READ` and
`APERIO_ALLOWED_PATHS_TO_WRITE` only seed the initial DB value on first run;
after that, the single `allowed-paths` DB setting governs both reads and
writes. The `getAllowlist()` function is used for both directions.

This is acceptable for a local-first personal tool but worth documenting
explicitly: the model can write anywhere it can read. If you later want to
restrict the model to read-only on certain indexed repos while allowing writes
only to the scratch workspace, the `pathStorage` (AsyncLocalStorage)
infrastructure already exists and could carry separate read/write lists.

**Proposed action (optional):** Add a note to `SECURITY.md` or `paths.js`
explaining the unified scope and how to split it if needed.

---

## 3. `set_paths` WebSocket message has no confirmation token flow

**Severity:** Low  
**Status:** Observation — acceptable given WebSocket auth  
**File:** `lib/emitters/handlers/wsHandler.js` lines 278–286

The `set_paths` handler widens the filesystem allowlist on receipt of a
well-formed message. It validates that the `paths` array contains non-empty
strings, then persists them immediately:

```js
case "set_paths": {
  const { paths } = data;
  if (!Array.isArray(paths)) return;
  const valid = p => typeof p === "string" && p.trim().length > 0;
  if (!paths.every(valid)) return;
  await setAllowlist(paths);
  send("paths_updated", { paths: getUserPaths() });
  return;
}
```

Unlike destructive file/GitHub actions, which go through `handleConfirmAction`
with a confirmation-token flow, `set_paths` applies immediately. This is
mitigated by:

- The WebSocket connection is authenticated (Origin check + optional
  `APERIO_AUTH_TOKEN`).
- The `X-Aperio-Client` header requirement prevents cross-site JS from
  reaching the WebSocket in the first place.
- The UI is the only intended client for this message type.

No action is strictly required unless the threat model expands to untrusted
WebSocket clients.

**Proposed action (optional):** If the allowlist UI ever needs a
"confirm" step (e.g., a modal that shows what folders are being added), add a
`confirm_paths` token flow mirroring `confirm_action`.

---

## 4. `audit-protocol.md` itself needs a version bump

**Severity:** Low (housekeeping)  
**Status:** Not started  
**File:** `audit-protocol.md`

The audit protocol document still references the old version context
(`0.48.3`/`0.56.0`). Its "Verification Baseline" section shows the last audit
run's test count (1570 tests) but doesn't note the current version or test
count. The document is still structurally useful as an audit checklist, but
should be updated to reflect the current codebase state so the next audit
starts from accurate context.

**Proposed fix:** Update the "Current Assessment" and "Verification Baseline"
sections to reference `0.65.0` and current test counts. Re-verify the
"Main Risks To Recheck" items and mark those that are now addressed (most of
them).

---

## 5. Rate limiting is sparse across the API surface

**Severity:** Low  
**Status:** Observation  
**Files:** `lib/routes/api-meta.js`, `lib/routes/api-settings.js`, `lib/routes/api-agents.js`, `lib/routes/api-sessions.js`, `lib/routes/api-restart.js`

Only three endpoints are currently rate-limited:
- `POST /api/setup/specs` and `POST /api/setup/config` (setup limiter)
- `POST /api/memories/import` (import limiter)
- `POST /api/data/import` (import limiter)

Notable state-changing endpoints with **no** rate limit:
- `PUT /api/provider` — changes the active AI provider/model at runtime
- `POST /api/paths` — widens filesystem allowlist
- `PUT /api/settings/:key` — modifies arbitrary settings
- `POST /api/agents/:id/run` — triggers background agent execution
- `PUT /api/agents/enabled` — toggles the agent-jobs master switch
- `POST /api/restart` — restarts the server
- `POST /api/skill` / `PUT /api/skill` / `DELETE /api/skill` — skill CRUD
- `POST /api/capabilities/install` — runs `pip install` system-side
- `POST /api/database/connections` / `DELETE /api/database/connections/:name` — DB connection CRUD
- `DELETE /api/sessions/:id` — deletes session data

For a strictly local app (`127.0.0.1`) this is low risk. If the app is used in
LAN mode with `APERIO_AUTH_TOKEN`, a compromised device on the local network
could spam these endpoints. The `express-rate-limit` dependency is already in
`package.json` — it just isn't applied broadly.

**Proposed action (optional):** Add a global rate limiter on `/api/*`
state-changing routes (POST/PUT/DELETE/PATCH), with higher limits for
read-only GET routes. The `makeRateLimiter` helper already exists.

---

## 6. `GET /api/memories` returns unbounded results

**Severity:** Low  
**Status:** Observation  
**File:** `lib/routes/api-memories.js` lines 13–19

The endpoint does a full `store.listAll()` with no pagination, limit, or
filtering:

```js
router.get("/memories", async (req, res) => {
  const rows = await store.listAll();
  res.json({ raw: rows });
});
```

For a personal tool with hundreds of memories this is fine. If the store grows
to thousands or tens of thousands of entries (plausible with auto-summarization
writing conversation summaries as project-type memories), this endpoint could
return multi-megabyte payloads and put pressure on both the server and the
browser UI that renders the sidebar.

**Proposed action (optional):** Add query parameters for pagination (`?limit=`
and `?offset=`) and/or filtering by type/tag. The sessions endpoint already
does this pattern (`listSessions({ page, limit })`).

---

## Summary

| # | Item | Type | Priority |
|---|------|------|----------|
| 1 | SECURITY.md version drift | Documentation bug | Fix soon |
| 2 | Unified read/write scopes | Observation | Optional |
| 3 | `set_paths` no confirm flow | Observation | Optional |
| 4 | audit-protocol.md version bump | Housekeeping | When convenient |
| 5 | Sparse rate limiting across API | Observation | Optional |
| 6 | `GET /api/memories` unbounded | Observation | Optional |

### Verdict on `audit-protocol.md`

**Keep it.** It is a well-structured, concrete audit checklist with actionable
questions organized by risk area. It serves as a recurring security posture
check that any agent or auditor can pick up and run. Update it when you fix
items 1 and 4 above so it stays current.

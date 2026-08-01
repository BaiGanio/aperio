# T45 — Overlapping WebSocket Chats: Reproduction and Stabilization Prompt

## Mission

Investigate and resolve the load-sensitive real-app regression test **T45** in
`tests/e2e/real-app/real-app-ws.test.js`. Do not presume there is a production
race. First establish whether the failure is in the real turn-lock lifecycle,
the test's synchronization barriers, or the aggregate test runner's resource
contention.

T45 protects a user-facing invariant: on one WebSocket connection, only the
newest chat turn may continue. A newer chat supersedes the active turn; the
superseded turn must emit `turn_complete` with `status: "interrupted"`, the
newest turn must complete normally, and the connection must remain usable.

## The exact scenario

T45 opens one real browser-style WebSocket connection and sends:

```text
t1: "one two three four five" → wait for a token
t2: "six seven eight nine ten" → wait for a token
t3: "eleven"
```

Expected result:

```text
t1: interrupted
t2: interrupted
t3: completed
t4 (sent afterwards): completed
```

The test appears at `tests/e2e/real-app/real-app-ws.test.js:364`.

## Known evidence

- `npm run test:e2e:real` uses `--test-concurrency=2` and has passed 85/85,
  including this T45.
- The aggregate `npm test` has reproduced a failure twice while thousands of
  unit, integration, E2E, and harness tests share the machine. In that case
  the **second** turn sometimes completes instead of being interrupted.
- `npm test` currently has no explicit `--test-concurrency` bound, unlike the
  focused E2E and integration runners.
- This is not the same T45 label in `real-app-security.test.js`; that one is
  an API-token test. This plan concerns the WebSocket test only.

Do not state that users have an overlapping-chat bug unless you reproduce the
wrong lifecycle on a focused or instrumented real-app run.

## Relevant implementation map

```text
WebSocket "chat" message
  → lib/emitters/handlers/wsHandler.js
  → createTurnLock() in lib/emitters/handlers/ws/turnLock.js
  → runAgentLoop(..., getAbort, setAbort)
  → provider streaming loop owns AbortController
  → stream_end / turn_complete
```

Read these before editing:

- `tests/e2e/real-app/real-app-ws.test.js` (T44 and T45 together)
- `lib/emitters/handlers/ws/turnLock.js`
- `lib/emitters/handlers/wsHandler.js` (chat dispatch and the
  `turn_complete` paths)
- `lib/emitters/handlers/ws/session.js`
- `tests/e2e/real-app/helpers.js` and its fixture/bootstrap helpers
- `id/reference/testing.md`

Because this touches agent/WebSocket cancellation behavior, also read
`tests/harness/README.md` before editing any agent loop, provider, tool, or
context code. Run `npm run test:harness` if any of those areas change.

## Constraints

- Preserve the dirty worktree; other sessions may be active. Do not stage,
  revert, or commit unrelated files.
- Do not start a casual server. The existing real-app fixture already uses a
  scratch root/DB and cleans up; use that harness for live verification.
- Do not weaken T45 by removing its real WebSocket, real turn lock, or
  connection-survival assertions.
- Do not replace the race with fixed sleeps. Prefer observable barriers:
  specific token, abort-registration, stream-end, or turn-completion events.
- Keep the normal user contract unchanged: a later chat supersedes the prior
  active turn on the same connection.

## Investigation sequence

1. Establish a baseline.

   ```sh
   npm run test:e2e:real
   ```

   Record the Node version, command, elapsed time, pass/fail count, and any
   port or fixture errors. If this fails, keep the captured stdout/stderr and
   diagnose it before changing the aggregate runner.

2. Exercise only the WebSocket real-app file repeatedly, using the existing
   isolated fixture. Add temporary diagnostics only if necessary, and remove
   them unless they become a deliberately bounded test assertion.

3. Reproduce aggregate pressure in controlled steps. Compare, at minimum:

   - focused real-app suite at concurrency 2;
   - the WebSocket file alone;
   - aggregate `npm test` as currently configured;
   - a bounded aggregate invocation (for example, Node test concurrency 2 or
     1) without changing package scripts first.

   Classify every observed failure precisely: wrong `turn_complete` status,
   timeout waiting for a token/completion, fixture boot/port failure, or
   unrelated suite failure.

4. Inspect the ordering proof. For the first and second turns, determine:

   - whether the test has observed a token from the intended turn rather than
     a token left in the shared message buffer from the prior turn;
   - whether that turn has registered its abort controller before the next
     chat arrives;
   - whether the next chat invokes the turn lock's supersession path;
   - whether an aborted provider loop can later publish a normal completion;
   - whether event-loop starvation merely changes when the test sends the next
     message.

5. Choose the narrowest evidence-backed repair.

   Possible outcomes (do not select one without evidence):

   - **Test-barrier flaw:** strengthen T45's per-turn event correlation or add
     an observable readiness barrier so the test cannot mistake an earlier
     token for the later turn being active.
   - **Runner contention only:** bound aggregate test concurrency in the
     appropriate package script, with an explanation and evidence that the
     focused behavior is sound.
   - **Production lifecycle bug:** fix the turn lock / completion ownership so
     an obsolete turn can never report `completed`; add a focused unit test
     plus the real-app regression proof.
   - **Fixture isolation bug:** repair ports, scratch state, or fixture cleanup
     without changing application semantics.

6. Add a regression test that fails before the chosen fix and passes after it.
   Keep T45's real-socket coverage. If production code changes, add the
   smallest unit-level contract test practical for the offending lifecycle
   edge as well.

## Definition of done

- The cause is documented with command output or a reproducible test, not
  inferred from a single timing failure.
- T45 remains a real WebSocket test and asserts `t1/t2 = interrupted`,
  `t3/t4 = completed`.
- `npm run test:e2e:real` passes repeatedly at its supported concurrency.
- The aggregate runner is green under its documented configuration, or its
  concurrency is intentionally bounded and the rationale is captured in the
  test script/comment and changelog.
- Any touched agent-loop/provider/context code passes `npm run test:harness`.
- Run the focused unit/integration tests for changed code, `git diff --check`,
  and verify no scratch DBs, servers, ports, or result artifacts are left
  behind.
- Remove the matching live entry from `id/reference/tech-debt.md` once fixed;
  this plan is the durable handoff while the work is open.

## Handoff report format

Report:

1. exact reproduction command(s) and result(s);
2. root-cause classification and supporting evidence;
3. files changed and why;
4. focused and broad verification results;
5. any residual risk or follow-up.


# Agent-loop regression harness

**If you are about to change `lib/agent/`, `lib/tools/`, `lib/context/`, or
`lib/providers/`, this is the suite that tells you whether you broke the
assistant's behavior. Run it before you commit:**

```bash
npm run test:harness      # ~0.7s, no network, no model, no MCP subprocess
```

---

## 1. Why this exists

Aperio's agent loop is the one place where a small, locally-correct change can
silently break something nobody notices until a user hits it: the correction
marker stops firing, the failure budget stops halting a runaway model, an
oversized tool result stops being offloaded and floods the context window (or
worse, ships raw over the socket). None of that is provable by unit tests —
those behaviors only exist when the *whole* loop runs — and before this harness
the only way to check them was to boot the app and chat at it until the
behavior showed up. That is slow, non-reproducible, and skipped under pressure.

There are two evaluators in this repo and they answer **different** questions:

| | Question it answers | Cost |
|---|---|---|
| **This harness** (`tests/harness/`) | *"Given fixed model output, did my refactor break the loop?"* | ~0.7s, deterministic, runs in CI |
| **Live tier-exam** (`scripts/model-tier-bench.js`, 65 drills) | *"Can model X actually drive Aperio?"* | Minutes, live llama.cpp, manual, nondeterministic |

They share one scorer (`evaluateBenchmarkCase()` in
`lib/helpers/modelTierBench.js`) and one scenario JSON shape on purpose, so a
drill can migrate between them. Use the harness for **code** changes and the
tier-exam for **model or prompt** changes.

## 2. What is real and what is fake

The whole point is that almost nothing is faked:

| Layer | In the harness |
|---|---|
| The model | **Fake** — `mock-provider.js` replays a scripted `providerScript` |
| Tool execution | **Fake handlers** — `host-tools.js`, in-process, deterministic |
| MCP client / subprocess | **Stubbed at the SDK layer** — reaching the real MCP boundary throws |
| `runAgentLoop` | **Real** (`lib/agent/index.js`) |
| Lifecycle middleware chain | **Real** (`lib/agent/middleware.js` + every registered middleware) |
| Tool hooks, safety budget, taint gate | **Real** (`tool-hooks.js`, `tool-safety-middleware.js`) |
| Offload / artifact store / `read_artifact` | **Real** (`lib/context/*`), writing real files in a temp sandbox |
| Path validation | **Real** (`runWithPaths`, `lib/routes/paths.js`) |
| Event emission | **Real** — captured by `makeSinkEmitter()` |

The `mock` provider **refuses to resolve unless `NODE_ENV=test`**
(`lib/providers/index.js`), and that refusal has its own test — it can never
become a shipping provider.

Each scenario runs inside its own `mkdtemp` sandbox that is removed in
`t.after()`. Nothing is left in the repo tree.

## 3. When to run it

- **Before committing** any change to `lib/agent/**`, `lib/tools/**`,
  `lib/context/**`, `lib/providers/**`. That is not a suggestion born of
  tidiness — it is the same path filter CI enforces.
- **After changing an event name, shape, or emission order.** The harness
  asserts the event contract (`tool_start` / `tool_result` /
  `tool_result_offloaded` / `tool_failure` / `tool_budget_exhausted` /
  `stream_start` / `token` / `stream_end` / `action_confirm_pending` /
  `plan_*`). The UI and the tier-exam both read those events; the harness is
  where a rename gets caught.
- **When adding a guardrail.** A guardrail with no harness scenario is a
  guardrail that will regress. Add the scenario in the same commit.
- **When a bug report describes loop behavior** ("it said it saved the file
  but didn't", "it kept retrying forever"). Reproduce it as a scenario first —
  the scenario is both the repro and the regression test.

CI: `.github/workflows/ci.agent-harness.yml` runs it on push/PR to
`master`/`dev`, path-filtered to the directories above. It is also part of
plain `npm test`.

## 4. Commands

```bash
npm run test:harness                              # whole suite
npm run test:only -- --test-name-pattern="drift"  # one test by name
npm run test:harness:ci:dashboard                 # → docs/benchmarks/harness/harness.html
```

Test names are deliberately written in plain language ("claiming to have saved
a file that was never actually written triggers an immediate correction")
because they double as the row labels on that dashboard — a non-developer
should be able to read the list and understand which behaviors are protected.

## 5. What the suite covers today

Three test files, 28 tests, 12 scenarios.

**`harness.test.js`** — the loop and its guardrails (G0, plus G3-1):

| Scenario | Pins |
|---|---|
| `happy-5-tool-chain` | A 5-tool chain records every step in order; the file really lands in the workspace; the shared scorer passes it *and* fails a deliberately wrong expected sequence |
| `false-write-claim` | A claimed-but-unwritten file triggers the appended `⚠️ **Correction:**` stream (`verifyFileClaims`) |
| `bad-json-budget` | 3 unparseable tool calls → 3 `tool_failure` (`kind: "parseArgs"`) → exactly one `tool_budget_exhausted` |
| `repeated-call-break` | The same failing call 3× halts on the 3rd attempt, not a 4th |
| `taint-gate` | After `fetch_url`, a `write_file` in the same turn receives `__tainted` and does not report success |
| `oversized-offload` | An 80 KB+ result becomes an artifact, is readable back via `read_artifact`, and its `tool_result` event carries `{ok, summary, artifact: {id, tokenCount, byteCount}}` with **no** raw `detail` blob (the WS3 data-exposure regression) |
| `confirm-pending-delete` | A `delete_file` result carrying a `Token:` line becomes `action_confirm_pending` with `destructive: true`, a basename-derived label and a `Target:` summary — and the turn **ends**: the queued second tool call and final answer never run |
| `confirm-pending-index-folder` | The other branch of the same payload derivation — label from the result's own `Action:` line, `📋` header stripped from the summary, `destructive: false` |
| `abort-mid-chain` | An abort after the first `tool_result` runs no further tools, writes none of the later steps' files, still closes the stream, records no `tool_failure`/`tool_budget_exhausted`, and ends `turn_complete{status: "interrupted"}` |
| — | The `mock` provider throws outside `NODE_ENV=test` |

**`planning.test.js`** — the config-gated planning loop
(`APERIO_AGENT_PLANNING=on`, `lib/agent/planning-middleware.js`):
`plan-valid-execution` (plan extracted, ordered `plan_step` events, no drift),
`plan-unknown-tool` (a plan naming a nonexistent tool never becomes active and
the turn still completes), `plan-drift` (calling off-plan is *recorded*, not
blocked), a no-plan fail-safe check, **G0 parity** (every G0 scenario produces
the same observable events with the gate on and off), and a lifecycle-trace
assertion that tool-safety middleware still runs before planning's `afterTool`.

**`spawn.test.js`** — sub-agent delegation (`lib/agent/spawn.js`): 3 parallel
children merge into the parent's stream with distinct `agent_id`s; one child
tripping its failure budget doesn't kill the parent or its siblings; a spec at
its recursion-depth limit refuses to spawn without throwing; a child spec
cannot widen the parent's `toolAllowlist` (rejected with the same
`AgentBundleError` an on-disk permission bundle would get).

## 6. How to add a scenario

Adding a behavior check is ~10 minutes. Adding a *good* one means the scenario
fails if and only if the behavior is broken.

**Step 1 — write the scenario JSON** (`scenarios/<id>.json`). Same shape as the
live exam's `.github/model-tiers/full-exam.json`, plus `providerScript`:

```json
{
  "id": "my-scenario",
  "title": "Plain-language sentence — this is what the dashboard shows",
  "userMessage": "What the user typed.",
  "providerScript": [
    { "tool": "fetch_data", "args": {} },
    { "text": "Final answer — ends the script." }
  ],
  "expectedToolSequence": ["fetch_data"],
  "requiredAnswerTerms": ["data"],
  "requireAllToolsSuccessful": true,
  "expectFiles": ["sales-report.txt"]
}
```

`providerScript` turn forms (see `mock-provider.js`):

| Form | Effect |
|---|---|
| `{ "tool": "name", "args": {…} }` | One scripted tool call; the script continues |
| `{ "text": "…" }` | Final answer — **ends** the script |
| `{ "plan": "APERIO_PLAN:{…}" }` | A non-terminal text preamble (planning loop); the script continues |
| `"args": { "__parse_error__": "…" }` | Simulates an unparseable tool call → `tool_failure` (`kind: "parseArgs"`) |
| `"args": { "x": "$lastArtifactId" }` | Substituted with the artifact ID from the previous result's offload preview — lets you round-trip through `read_artifact` |

The trailing fields (`expectedToolSequence`, `requiredAnswerTerms`,
`requireAllToolsSuccessful`, `expectFiles`) are what the **shared scorer**
reads. Set them when the scenario is a pass/fail behavior check; omit them when
your test asserts on events directly.

One harness-only field: **`abortAfterTools: N`** aborts the turn after the Nth
`tool_result`, driven by a real `AbortController` wired exactly as the
per-connection turn lock wires it in production (`ws/turnLock.js`). That is how
you script "the user pressed stop mid-chain". With it set, the driver's closing
`turn_complete` carries `status: "interrupted"` instead of `"completed"`, the
same distinction `wsHandler.js:304` draws.

**Step 2 — make sure your tools exist.** Scenarios can only call handlers from
`host-tools.js` (currently `recall`, `fetch_data`, `analyze_data`,
`save_report`, `verify_report`, `send_report`, `fetch_large_dataset`,
`fetch_url`, `write_file`, `flaky_tool`, `delete_file`, `index_folder`).
Anything else hits the stubbed MCP client and throws with a pointed message.
Add a handler there if you need one.

Four names are **deliberately real Aperio tool identifiers** because the safety
middleware and tool hooks key off them literally
(`lib/agent/tool-profiles.js`): `fetch_url` (taints the turn), `write_file`
(receives `__tainted`), `delete_file` (a `CONFIRM_TOOLS` member, styled
destructive with a path-derived label) and `index_folder` (a `CONFIRM_TOOLS`
member, non-destructive, labelled from its own `Action:` line). Every other name
is synthetic so an unrelated scenario can't trip a gate by accident. Keep that
property: name a new tool synthetically unless you *want* its gate.

The two confirm handlers mirror the real producers' output byte-for-byte
(`mcp/tools/files/delete.js`, `lib/agent/host-tools/index-folder.js`) because
`tool-hooks.js` parses that text to build the confirm payload. If you change a
producer's format, change the fixture with it — the parse is the contract.

**Step 3 — assert.** Add a test that reads the scenario and drives it:

```js
const scenario = loadScenario("my-scenario");
const { events, finalText, scratchDir } = await runScenario(t, scenario);
assert.ok(events.some(e => e.type === "tool_result" && e.ok));
// …or hand it to the shared scorer:
assert.equal(evaluateBenchmarkCase(scenario, events).status, "pass");
```

`runScenario` (`run-scenario.js`) handles the sandbox, the MCP stub, the host
tools, path scoping, and the `turn_complete` event the scorer needs.

**Step 4 — prove it has teeth.** Break the behavior on purpose (comment out the
guardrail, rename the event) and confirm your new test goes red. A scenario
that passes against broken code is worse than no scenario: it is a false
assurance that costs 0.7s per run forever.

## 7. When a harness test fails, where to look

| Symptom | Likely layer |
|---|---|
| Tool sequence differs from `expectedToolSequence` | `runAgentLoop`'s tool dispatch, or `selectTools` middleware dropped a tool |
| Missing `tool_start`/`tool_result` | Event emission in `lib/agent/tool-hooks.js` |
| `tool_budget_exhausted` missing or fires at the wrong count | `lib/agent/tool-safety-middleware.js` (failure budget = 3, repeated-call break) |
| `⚠️ **Correction:**` missing | `verifyFileClaims()` in `tool-hooks.js`, or the scratch dir isn't resolving |
| No `tool_result_offloaded`, or `detail` present on an offloaded result | `lib/context/toolResultOffload.js` / `model-context-middleware.js` ordering — the summary must be built **before** offload but stripped after |
| Taint flag missing | `tool-profiles.js` set membership, or middleware ordering |
| "harness scenario reached the real MCP boundary" | Your scenario calls a tool that isn't in `host-tools.js` |
| `plan_*` assertions fail | `planning-middleware.js`; check `APERIO_AGENT_PLANNING` is set inside that test |
| Middleware-order test fails | A new middleware registered before tool-safety — safety must stay first |
| `action_confirm_pending` missing, wrong label, or the turn kept going | The confirm block in `tool-hooks.js` (`Token:` regex, `CONFIRM_TOOLS` membership, `emitter._confirmPending`), or a producer changed its output format out from under the fixture |
| Abort test runs tools it shouldn't | The provider loop stopped checking `getAbort()?.signal?.aborted` at the top of each iteration |

## 8. What this harness deliberately does *not* cover

Knowing the edges keeps you from trusting it further than it earns:

- **Real model behavior.** The script *is* the model. "Would Qwen actually call
  these tools?" is the tier-exam's question, not this one.
- **Provider adapters.** Only the `mock` provider runs here. Bugs inside
  `lib/agent/providers/anthropic.js` et al. are invisible to it. This has one
  sharp edge worth naming: the abort scenario proves the *loop and emitter* side
  handle an interrupted turn cleanly, and pins the mock's abort semantics to
  production's, but a real adapter that stopped checking its own abort signal
  would not be caught here.
- **The WebSocket/HTTP layer.** `runAgentLoop` is driven directly, so
  `wsHandler`, session persistence, and turn locking are out of frame — that is
  `tests/e2e/`'s job. (The harness even emits `turn_complete` itself, because
  in production that is `wsHandler`'s.)
- **Multi-turn conversations.** One `runAgentLoop` call per scenario. History
  trimming and RAG re-injection across turns are not exercised.
- **Confirmation resume.** The *emit* half of the confirm flow is covered (the
  event fires, the turn stops). The user's confirm/deny round-trip — and
  therefore whether the action ever actually runs — lives in
  `lib/emitters/handlers/ws/interrupts.js` and `lib/routes/api-interrupts.js`,
  outside the harness. Note those two sites gate on their own
  `CONFIRMABLE_TOOLS` list, separate from the `CONFIRM_TOOLS` list the emit side
  uses; nothing in either suite asserts the two agree (logged in
  `id/reference/tech-debt.md`).
- **Real MCP tools.** Handlers are fakes; whether `write_file` itself is
  correct is `tests/integration/`'s job.

## 9. The G0-4 drill (manual, occasional)

A green suite cannot prove it *would* have caught a break. This drill can, and
it takes a minute:

1. In `lib/agent/tool-hooks.js`, rename the `tool_start` event type string
   (e.g. `"tool_start"` → `"tool_start_RENAMED_FOR_DRILL"`).
2. `npm run test:harness` — `happy-5-tool-chain` and several others must fail.
3. Revert the rename. Suite goes green again.

Worth re-running after any significant change to the event contract or the
middleware chain. Last verified 2026-07-24, when the harness landed.

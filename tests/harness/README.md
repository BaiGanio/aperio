# Agent-loop regression harness (WS0)

Deterministic regression net for the agent loop, middleware stack, and tool
hooks — no network, no live model, no real MCP subprocess. Companion to
[`trash/plans/agent-harness-epic/agent-harness-epic.md`](../../trash/plans/agent-harness-epic/agent-harness-epic.md)
(plan) and [`agent-harness-epic-tests.md`](../../trash/plans/agent-harness-epic/agent-harness-epic-tests.md)
(criteria).

## What this is

A scripted `mock` provider (`mock-provider.js`) drives the real
`runAgentLoop`, `lib/agent/middleware.js` lifecycle runner, `tool-hooks.js`,
and `tool-safety-middleware.js` against a set of canned "model" turns
(`scenarios/*.json`). The only fake thing in the whole run is the model's
output — everything downstream of it is production code. Tool execution
itself is faked too (`host-tools.js`), so no MCP subprocess ever spawns.

Run it: `npm run test:harness` (included in `npm test`).

## G0-4 — regression teeth (manual drill)

This one criterion is a manual drill, not an automated test — it proves the
harness actually fails when the code it watches breaks, which a passing suite
alone can't demonstrate.

1. In `lib/agent/tool-hooks.js`, temporarily rename the `tool_start` event
   type string (e.g. `"tool_start"` → `"tool_start_RENAMED_FOR_DRILL"`).
2. Run `npm run test:harness`. `happy-5-tool-chain` and several other
   scenarios should fail red.
3. Revert the rename. The suite should go green again.

Verified 2026-07-24 against the tree at the time WS0 landed.

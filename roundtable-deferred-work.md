# Round-Table Mode — Deferred Work

Tasks intentionally skipped during the initial implementation session
(`multi-agent-roundtable-plan.md`). Pick these up in a follow-up session.

---

## 1. Integration test with two local Ollama models

**Spec source:** `multi-agent-roundtable-plan.md` §8 "Integration test".

**File to create:** `tests/roundtable.integration.test.js`

**Requirements:**
- Boot the WS server with
  `ROUNDTABLE_AGENTS=ollama:qwen2.5:3b,ollama:llama3.1` so CI does not burn
  cloud API credits.
- Open a WS client, send a `chat` message with `roundtable: true`.
- Assert: `roundtable_phase` events arrive in the expected order
  `answer → review → (revise → rereview)* → agreed | no_agreement`.
- Assert: every `token` event carries an `agent_id`.
- Assert: the shared `messages` transcript ends in a single assistant turn
  containing the consensus text (or both positions).

**Prereqs not yet satisfied:**
- Need a CI-friendly way to boot Ollama with two small models present
  (consider a `docker-compose.test.yml` or a skip-if-no-ollama guard).
- May need to extend the test runner to spin a real HTTP+WS server on a
  random port instead of mocking.

**Prompt to paste in the next session:**

> Open `roundtable-deferred-work.md`, read task 1, and implement
> `tests/roundtable.integration.test.js`. The orchestrator, WS protocol,
> and unit tests already exist — wire a real end-to-end test using two
> Ollama models. Skip the test gracefully if Ollama is not reachable.

---

## 2. Bulk i18n translations for the 22 non-EN/BG locales

**Spec source:** `multi-agent-roundtable-plan.md` §5.2 i18n notes.

For v1 the new keys (`discuss_button_label`, `roundtable_phase_*`,
`roundtable_consensus_label`, etc.) fall back to English in 22 locales.
Open a follow-up to fan these out via the standard translation workflow.

---

## 3. Round-table CLI mode

**Spec source:** `multi-agent-roundtable-plan.md` §10 "Out of scope".

`lib/terminal.js` chat client currently bypasses round-table. If/when we
want the same cross-review behaviour from the terminal, replicate the
orchestrator entry path used by `wsHandler`.

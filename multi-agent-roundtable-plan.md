# Multi-Agent Round-Table Mode — Implementation Plan

> **How to use this file.** Open a fresh Claude Code session in
> `/Users/lk/Projects/BaiGanio/aperio` and paste:
> *"Read `multi-agent-roundtable-plan.md` and implement
 it end-to-end.
> Stop after each milestone for review."*
>
> This file is written as instructions to the implementer. It is intentionally
> self-contained — assume zero prior conversation context.

---

## 1. Mission

Add a **round-table mode** to Aperio chat where **two AI agents** answer the
user's question, **review each other's reply**, and iterate until they reach
**explicit agreement** — or a hard ceiling of rounds is hit.

Goal: *cross-verification of answers from two independent models*, surfaced as
a single converged reply (or an explicit "no agreement" card showing both
positions).

Non-goal: free-form agent chit-chat, multi-agent role-play, debate-for-its-own-sake.
The protocol must terminate; it must produce **one consensus answer** when
possible.

---

## 2. Project context (minimum needed to start)

- Aperio is a self-hosted memory layer + chat UI. Express + WebSocket server
  in `server.js`, agent loop in `lib/agent.js`, browser UI in `public/`.
- Today exactly **one** agent is created per server boot
  (`lib/agent.js:249` `createAgent()` reads `AI_PROVIDER` from env).
- The agent connects to MCP tools (`mcp/index.js`), runs an Anthropic loop or
  an Ollama-compatible OpenAI loop, streams tokens over WS via
  `lib/emitters/wsEmitter.js`.
- Per-WS-connection state (`messages` array, `abortController`) lives in
  `lib/emitters/handlers/wsHandler.js:64`.
- The frontend renders user/assistant bubbles via
  `public/scripts/message-handler.js:506` `addMessage(role, …)` — currently
  only `user` vs `ai` is distinguished.
- i18n: 24 EU languages, see `public/scripts/i18n.js` and the `LANG_NAMES`
  map in `lib/agent.js:265`. New UI strings need entries in both.
- Memory: shared pgvector / LanceDB store via `db/index.js`. Two agents will
  read the same recall but should tag writes with the agent name.

Read these files end-to-end before writing code:
- `lib/agent.js` (462 lines — provider resolution, runAnthropicLoop, runOllamaLoop)
- `lib/emitters/handlers/wsHandler.js` (423 lines — per-connection state, chat handler)
- `lib/emitters/wsEmitter.js`
- `public/scripts/message-handler.js` (954 lines — streaming UI, bubble logic)
- `public/index.html` and the input bar at `public/scripts/input-bar.js`

---

## 3. Design principles (do not violate)

1. **Strictly sequential.** Agent A speaks, then Agent B reacts. No parallel
   streaming. The UI is calmer and the convergence prompt to B can reference
   A's full reply verbatim.
2. **Convergence, not chatter.** Every non-final agent turn is given a
   structured prompt that forces it to either say `AGREED` or produce a
   *specific* objection. Vague "interesting points" answers get rejected by
   a parser and re-prompted once.
3. **Hard round cap.** Default `MAX_ROUNDS = 3` (counts each agent reply,
   so up to 6 LLM calls per user turn). Configurable via
   `ROUNDTABLE_MAX_ROUNDS` env var.
4. **Determinate termination.** Loop exits on (a) explicit agreement,
   (b) round cap, or (c) abort. There is no "let them keep going" path.
5. **Single source of truth for personas.** Personas live in
   `id/whoami-<name>.md`. The base `id/whoami.md` is loaded for both;
   per-persona overrides are appended.
6. **Backwards compatible.** Default chat (no round-table) must keep working
   identically. Round-table is opt-in via a UI toggle and a new WS message.

---

## 4. The Round-Table Protocol

### 4.1 State machine

```
        ┌─────────── user message U ───────────┐
        ▼                                      │
   [Agent A turn 1]   answers U → A1           │
        │                                      │
        ▼                                      │
   [Agent B turn 1]   sees U + A1 → B1         │
        │                                      │
        ▼                                      │
    parse(B1)                                  │
        │                                      │
   ┌────┴─────┐                                │
   AGREED    OBJECTS                           │
   │             │                             │
   │             ▼                             │
   │       [Agent A turn 2]   sees U+A1+B1→A2  │
   │             │                             │
   │             ▼                             │
   │         parse(A2)                         │
   │       ┌─────┴─────┐                       │
   │     AGREED      OBJECTS                   │
   │       │             │                     │
   │       │             ▼ (round 3, etc.)     │
   │       │           ...                     │
   ▼       ▼                                   │
  emit final consensus                         │
   OR (cap hit) emit "no agreement" card ──────┘
```

### 4.2 Persona system prompts

Both personas are loaded as `getSystemPrompt()` overrides via
`id/whoami-<name>.md`. Stored as a **suffix** that follows the base
`id/whoami.md` content.

**`id/whoami-primary.md`** (Agent A — the answerer)

```
You are Agent A in a two-agent round-table. Your role this turn depends on the
phase indicated in the user message:

PHASE = ANSWER:
- Provide the best answer you can to the user's question.
- Be specific. Cite reasoning, not vibes. State assumptions explicitly.
- Keep it under 400 words unless the question genuinely requires more.

PHASE = REVISE:
- A peer agent (Agent B) has reviewed your previous answer and raised
  objections. The objections are quoted in the user message.
- For each objection: either accept it (and integrate the correction) or
  reject it with a concrete reason (evidence, source, logical refutation).
- If after considering B's points you fully agree with B's revised view,
  begin your reply with the literal token "AGREED:" followed by the
  synthesized final answer.
- Otherwise produce a revised answer A2 that addresses each objection.
  Do not repeat unchanged content from A1; reference it by saying
  "Unchanged from A1: …".

Never apologize, never thank the peer, never use phrases like "great point".
Disagree clearly when you disagree. Agree clearly when you agree.
```

**`id/whoami-verifier.md`** (Agent B — the reviewer)

```
You are Agent B in a two-agent round-table. Your role this turn depends on the
phase indicated in the user message:

PHASE = REVIEW:
- Agent A has answered the user. A's reply is quoted in the user message.
- Your job: find errors, gaps, unstated assumptions, and counter-evidence.
- Output format is strict:
  - If you fully endorse A's answer, reply with exactly:
        AGREED: <one-sentence endorsement explaining why A is correct>
  - Otherwise, reply with a numbered list of objections. Each objection must
    name (a) the specific claim or omission, (b) why it is wrong or
    incomplete, (c) what the corrected version would say. No preamble,
    no closing remarks.

PHASE = REREVIEW:
- Agent A has revised its answer in response to your prior objections.
  A's new reply is quoted in the user message, alongside your prior objections.
- For each prior objection, state explicitly: RESOLVED / PARTIAL / UNRESOLVED.
- If all are RESOLVED, reply with exactly:
        AGREED: <one-sentence endorsement>
- Otherwise produce a new (shorter) numbered list of remaining objections.

Do not invent new objections that were not implicit in your earlier review
unless A's revision introduced new errors. Do not be contrarian for its own
sake. If you genuinely agree, say AGREED.
```

### 4.3 Convergence parser

A reply is considered "agreement" iff its first non-whitespace token is
`AGREED:` (case-insensitive, optional leading `**`). Anything else is
treated as an objection.

If a reply contains `AGREED` mid-text but not as the leading token, the
orchestrator must re-prompt the agent **once** with: *"Your previous reply
mixed agreement with objections. Please follow the strict format: either lead
with AGREED: <endorsement>, or list numbered objections only."* If the second
attempt still fails, treat it as an objection and continue.

### 4.4 Final consensus rendering

- **Both agreed within cap:** the final agreed reply is rendered as a single
  bubble labeled "Consensus" with both agent badges shown.
- **Cap hit without agreement:** render two side-by-side cards titled
  "Agent A's position" and "Agent B's position", each containing that
  agent's *last* substantive (non-objection) reply. Show a banner:
  "No consensus reached after N rounds — review both positions."
- **User abort mid-loop:** stop cleanly, render whatever bubbles already
  streamed, mark the turn as "interrupted".

---

## 5. File-by-file change list

### 5.1 Server-side

**`lib/agent.js`** (refactor `resolveProvider` and `createAgent`)

- Change `resolveProvider()` to accept an explicit config object instead of
  reading `process.env` directly. Keep an `resolveProviderFromEnv()`
  back-compat shim.
- Allow `createAgent({ root, version, providerConfig, persona })` so the
  same factory can be called twice with different providers/personas.
- `getSystemPrompt()` should accept a `persona` parameter and append
  `id/whoami-<persona>.md` after the base `id/whoami.md`.
- Each agent gets its own MCP client (already the case — each `createAgent`
  call spawns `StdioClientTransport`). Verify this still works when called
  twice; add a small integration test.

**`lib/emitters/wsEmitter.js`** (thread `agent_id` through events)

- Add an optional `agent_id` (and `persona` label) field to every emitted
  event: `stream_start`, `token`, `tool`, `stream_end`, `reasoning_token`,
  `reasoning_done`, `context_warning`, `context_trimmed`.
- Add a factory `makeWsEmitter(ws, { agentId, persona })` that bakes the
  ID into every send.

**`lib/agent.js`** (emit sites)

- Every `emitter.send({ type: ... })` call inherits `agent_id` from the
  emitter factory. No call-site changes needed if the factory injects it.
  Verify by grepping for `emitter.send(` after the refactor — every event
  reaching the WS must carry an agent_id.

**`lib/workers/roundtable.js`** (NEW — orchestrator)

```js
// Sketch. Implement fully in the actual file.
export async function runRoundTable({
  agents,            // [{ id, persona, runAgentLoop, callTool }, ...]   length === 2
  userText,          // string
  attachments,       // unchanged from current chat handler
  sharedTranscript,  // ref to wsHandler's `messages` array
  emitter,           // base ws emitter (can be re-wrapped per agent)
  lang,
  maxRounds = 3,
  abortRef,
}) {
  // 1. Build agent-specific message buffers.
  // 2. Append PHASE-tagged user message to the active agent's buffer.
  // 3. Call agent.runAgentLoop with a per-agent emitter that injects
  //    { agent_id, persona } into every event.
  // 4. Capture the final reply text. Strip tool_use / tool_result blocks
  //    before showing it to the *other* agent (cross-agent transcript view
  //    must not contain dangling tool_use IDs — Anthropic 400s on those).
  // 5. Parse for AGREED. If yes, emit { type: "roundtable_agreed", ... }
  //    and return the consensus.
  // 6. Otherwise switch active agent, build the next PHASE-tagged prompt
  //    (REVIEW / REVISE / REREVIEW), loop.
  // 7. On cap, emit { type: "roundtable_no_agreement", positions: [...] }.
  // 8. Persist the converged answer (or last positions) to sharedTranscript
  //    so summarize / resume_session work afterwards.
}
```

Key invariants:
- **Each agent has its own message buffer** initially seeded with
  `[{ role: "user", content: <PHASE-tagged prompt> }]`. Do NOT share the
  buffer between agents — Anthropic and Ollama disagree on tool_use ID
  shape and will collide.
- **The PHASE-tagged prompt** for agent B in REVIEW phase looks like:
  ```
  PHASE: REVIEW
  Original user question:
  > {userText}
  Agent A's answer:
  > {A1}
  ```
- **REREVIEW prompt** includes the prior objections and A's revision:
  ```
  PHASE: REREVIEW
  Original user question:
  > {userText}
  Your prior objections:
  > {B1}
  Agent A's revised answer:
  > {A2}
  ```
- **Tool calls during a round-table turn** are allowed but only mutate that
  agent's local buffer. Memory writes (`remember`) propagate to the shared
  store immediately; recall snapshots are taken at orchestrator start to
  avoid intra-turn races. (Implement: take one `recall` at start, pass the
  result as system context to both agents.)

**`lib/emitters/handlers/wsHandler.js`** (new chat path)

- Add a `roundtable` field to the `chat` message: when `true`, route to the
  round-table orchestrator instead of the single `runAgentLoop`.
- Store both agents in the closure: `const agents = [primary, verifier];`
  where `primary` and `verifier` are the two `createAgent` results passed
  into `makeWsHandler`.
- On round-table abort (`stop` WS message), cascade the abort to whichever
  agent is currently streaming.
- The `messages` shared transcript stores final consensus or both positions
  in a single assistant turn so `summarize`/`resume_session` keep working.

**`server.js`** (boot two agents)

- Read `ROUNDTABLE_AGENTS` env var. Format:
  `ROUNDTABLE_AGENTS=anthropic:claude-haiku-4-5-20251001,deepseek:deepseek-chat`
  (comma-separated `provider:model` pairs).
- If unset and `AI_PROVIDER` is set, only the single agent boots — no
  round-table mode available, UI button is disabled.
- If set, call `createAgent` twice with the parsed configs and the
  `primary` / `verifier` personas. Pass both to `makeWsHandler`.

### 5.2 Frontend

**`public/scripts/message-handler.js`**

- Extend `addMessage(role, text, attachments, opts)` to take
  `opts = { agentId, persona, label, color }`. When `agentId` is set,
  apply a CSS class `message-agent-${agentId}` and render an avatar with
  the persona initial + a colored ring.
- Track `currentBubble` as a `Map<agentId, HTMLElement>` instead of a
  single ref. On `stream_start { agent_id }` create a new bubble keyed by
  agent_id; on `token { agent_id }` append to that bubble; on
  `stream_end { agent_id }` finalise that bubble.
- Handle two new event types:
  - `roundtable_phase { phase, agent_id }` — render a small status chip
    above the next bubble: "Reviewing…", "Revising…", "Re-reviewing…".
  - `roundtable_agreed { text, agents }` — replace the last two bubbles
    (or render a fresh one) with a single "Consensus" bubble whose header
    shows both agent badges.
  - `roundtable_no_agreement { positions }` — render a side-by-side
    two-column card. Use existing CSS grid; new selector
    `.roundtable-no-consensus`.
- `addThinking` becomes per-agent: `addThinking({ agentId })`.

**`public/scripts/input-bar.js`**

- Add a "Discuss" toggle (icon: two-speech-bubbles) next to the send
  button. When ON, the next `chat` WS message includes `roundtable: true`.
- Disabled state when only one agent is configured (server sends a
  `provider` event with `roundtableAvailable: false`).

**`public/index.html`** and **`public/styles/`**

- Add CSS for two persona colors (suggest: `--agent-primary: #7c3aed`,
  `--agent-verifier: #0891b2`). Apply to bubble border + avatar ring.
- Consensus bubble: gold/green left border, "Consensus" pill in the header.
- "No agreement" card: two columns, equal width, divider in the middle.

**`public/scripts/i18n.js`**

- New translation keys (English first, Bulgarian second; the other 22
  locales can fall back to English for v1 — file an issue for batch
  translation later):
  - `discuss_button_label` → "Discuss"
  - `discuss_button_tooltip` → "Two agents will cross-review answers"
  - `roundtable_phase_review` → "Agent B reviewing…"
  - `roundtable_phase_revise` → "Agent A revising…"
  - `roundtable_phase_rereview` → "Agent B re-reviewing…"
  - `roundtable_consensus_label` → "Consensus"
  - `roundtable_no_consensus_banner` → "No consensus after {n} rounds"
  - `roundtable_position_a` → "Agent A's position"
  - `roundtable_position_b` → "Agent B's position"

### 5.3 Memory tagging

- When either agent calls `remember` mid-round-table, automatically append
  a tag `agent:<id>` and `roundtable:<sessionId>:<turnIdx>` to the
  memory's tags array. Implement in the orchestrator's `callTool` wrapper,
  not in the agents themselves. This way, you can later filter the memory
  side panel by agent.

### 5.4 Configuration & docs

- `.env.example`: add the new variables with comments.
  ```env
  # Round-table mode — two agents cross-review each other.
  # Format: provider:model[,provider:model]
  # ROUNDTABLE_AGENTS=anthropic:claude-haiku-4-5-20251001,deepseek:deepseek-chat
  # ROUNDTABLE_MAX_ROUNDS=3
  ```
- `README.md`: add a "Round-table mode" section under Architecture.
- `future-work.md`: move the entry for this feature to "Done" once shipped.

---

## 6. WebSocket protocol additions

| Event (server → client) | New fields | Purpose |
|---|---|---|
| `provider` | `roundtableAvailable: bool`, `agents: [{id, persona, name, model}]` | Tell UI whether to enable Discuss toggle |
| `stream_start` | `agent_id`, `persona` | Route tokens to right bubble |
| `token` | `agent_id` | Same |
| `stream_end` | `agent_id` | Same |
| `tool` | `agent_id` | Show which agent called the tool |
| `roundtable_phase` | `phase` (`answer`/`review`/`revise`/`rereview`), `agent_id` | UI status chip |
| `roundtable_agreed` | `text`, `agents`, `rounds` | Render consensus bubble |
| `roundtable_no_agreement` | `positions: [{agent_id, text}, {agent_id, text}]`, `rounds` | Render side-by-side card |

| Event (client → server) | New fields | Purpose |
|---|---|---|
| `chat` | `roundtable: bool` | Opt into round-table for this turn |

---

## 7. Edge cases and failure modes

1. **Anthropic tool_use ID collisions** when folding A's reply into B's
   buffer. Solution: strip all `tool_use` and `tool_result` blocks from
   cross-agent views; only text blocks pass between agents.
2. **One agent fails mid-round** (network error, Ollama crash). Behaviour:
   surface the error in that agent's bubble, abort the round-table, and
   leave the other agent's last reply as a normal single-agent answer.
3. **Both agents are the same provider but different models**
   (e.g. two Anthropic models). Allowed. The MCP child processes are
   independent, so this works.
4. **User aborts mid-stream.** The current `stop` WS message must abort the
   currently-streaming agent's `AbortController`. Add an
   `orchestratorAbort` ref so the loop also checks between rounds.
5. **Token explosion.** Each round adds ~2× tokens to the next agent's
   prompt. Add a per-round-table token budget: if accumulated input tokens
   exceed `0.6 * min(contextWindow_A, contextWindow_B)`, force-end with
   "no agreement" instead of starting another round. Emit a
   `roundtable_truncated` event.
6. **Reasoning model inside round-table.** Thinking models (qwen3, deepseek-r1)
   may emit huge reasoning blocks. Strip `reasoning_content` from
   cross-agent views — only the final clean text passes.
7. **Memory write conflict.** If both agents call `remember` with similar
   content in the same turn, deduplication via the existing
   `deduplicateMemories` worker handles it eventually. No special-case for v1.
8. **Persona prompt drift.** Periodically re-check that personas still
   produce `AGREED:` cleanly. Add a regression test (see section 8).

---

## 8. Test plan

### Unit tests (under `tests/`)

- `tests/roundtable.parser.test.js`
  - `parseAgreement("AGREED: looks correct")` → `{ agreed: true, ... }`
  - `parseAgreement("**AGREED:** yes")` → `{ agreed: true, ... }`
  - `parseAgreement("1. Objection: …")` → `{ agreed: false, ... }`
  - `parseAgreement("Mostly agreed but …")` → `{ agreed: false, malformed: true }`
- `tests/roundtable.transcriptFold.test.js`
  - Folding Anthropic content blocks: tool_use + tool_result pairs are
    stripped, text blocks remain.
  - Folding Ollama messages: tool/role blocks are stripped.
- `tests/roundtable.orchestrator.test.js`
  - Mock two `runAgentLoop` impls. Verify:
    - Agreement on round 1 → returns consensus, never calls Agent A again.
    - Agreement on round 2 → returns consensus from A2.
    - Cap hit → returns no-agreement with both last positions.
    - Abort mid-round → returns interrupted, no further calls.

### Integration test

- `tests/roundtable.integration.test.js`
  - Boot the WS server with `ROUNDTABLE_AGENTS=ollama:qwen2.5:3b,ollama:llama3.1`
    (two local models so CI doesn't burn API credits).
  - Send a chat message with `roundtable: true`.
  - Assert: receives `roundtable_phase` events in order
    `answer → review → (revise → rereview)* → agreed | no_agreement`.
  - Assert: every `token` event carries `agent_id`.

### Manual UI checklist

- [ ] Discuss toggle appears and is enabled when two agents configured.
- [ ] Two distinct bubble colors render correctly in light + dark theme.
- [ ] Consensus bubble has both badges in the header.
- [ ] No-agreement card renders side-by-side, scrollable on mobile.
- [ ] Abort mid-round-table stops streaming cleanly, no orphaned bubbles.
- [ ] `summarize` after a round-table turn includes the consensus, not the
      raw cross-talk.
- [ ] `resume_session` restores the consensus correctly.

---

## 9. Acceptance criteria (definition of done)

1. Booting with `ROUNDTABLE_AGENTS=anthropic:...,deepseek:...` starts the
   server with two healthy MCP children, both visible in `/api` health.
2. A user with the Discuss toggle ON sends "What is the capital of Australia?"
   and sees: A answers Canberra; B replies `AGREED:`; one consensus bubble.
3. A user sends a contestable question (e.g. "Is JavaScript single-threaded?")
   and sees one round of objection + revision before agreement, with both
   bubbles streaming distinctly.
4. A user sends a deliberately divisive question and, after 3 rounds,
   sees the no-agreement card with both final positions.
5. Aborting mid-round leaves a clean UI with no dangling spinners.
6. With Discuss toggle OFF, behaviour is identical to today (regression-free).
7. All new unit + integration tests pass. No new lint errors.
8. Token usage banner shows the *combined* token total for the turn.

---

## 10. Out of scope (V2 / later)

- Three or more agents.
- Parallel streaming (agents speak simultaneously).
- A separate "moderator" agent that synthesises.
- Per-agent memory namespaces (today: shared store with agent tags).
- Round-table CLI mode (the `lib/terminal.js` chat client). Web UI only for v1.
- User-tunable persona prompts via UI. (For v1, edit
  `id/whoami-primary.md` / `whoami-verifier.md` directly.)
- Auto-detection of when round-table is "worth it" — for v1 the user
  toggles it manually per turn.

---

## 11. Suggested implementation order

Build in milestones; each one should leave the app working and committable:

1. **M1 — Refactor `createAgent` to accept explicit provider config.**
   No behaviour change. Existing single-agent path goes through
   `resolveProviderFromEnv()`. Tests still pass.
2. **M2 — Boot two agents in `server.js`** when `ROUNDTABLE_AGENTS` is set.
   Wire both into `wsHandler` but only use the primary for chat. Verify
   both MCP children stay healthy.
3. **M3 — Add `agent_id` to WS events.** Single agent still works; the
   field is set to `"primary"` for now.
4. **M4 — Frontend: render `agent_id`-tagged bubbles.** Single agent looks
   identical to before (one bubble color). No round-table yet.
5. **M5 — Build `lib/workers/roundtable.js`** with mocked agents + unit tests.
6. **M6 — Wire orchestrator into `wsHandler` behind `roundtable: true`** flag.
   Test with two real Ollama models locally.
7. **M7 — Add Discuss toggle + consensus / no-agreement UI.**
8. **M8 — i18n + docs + .env.example + README section.**
9. **M9 — Integration test, manual checklist, polish.**

Stop after each milestone for review — the user explicitly asked for this.

---

## 12. Open questions for the user (ask before M2)

1. **Default agent pair.** Recommend `anthropic + deepseek` (both cloud,
   diverse training, cheap). Confirm or override.
2. **Where should the Discuss toggle live?** Recommend: next to the send
   button in the input bar. Confirm or move it to the navbar.
3. **Should round-table be the *default* on for some question types**
   (e.g. "what should I…", "is X correct…")? Recommend: no — manual toggle
   only for v1. Confirm.
4. **Memory writes during round-table.** Recommend: tag with
   `agent:<id>`, `roundtable:<turnId>`. Confirm tag schema.
5. **Cost cap.** Should there be a hard daily-token cap to prevent runaway
   round-tables on cloud models? Recommend: not in v1; surface the
   per-turn cost in the UI instead.

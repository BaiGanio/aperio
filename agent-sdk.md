# Agent SDK provider — audit & implementation plan

**Goal:** Let Aperio drive Claude through the user's **Claude Pro/Max subscription** instead of the
metered Anthropic Messages API, by adding a new provider (`AI_PROVIDER=claude-code`) backed by the
**Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`).

This document is the result of a full audit of the current agent stack and is written so the feature
can be implemented in a later session without re-deriving context. Status: **plan only, nothing
implemented yet.**

---

## 0. TL;DR / decisions

- **It is achievable.** The Agent SDK (and `claude -p`) authenticate with the same credentials as
  Claude Code, so a logged-in Pro/Max subscription pays for the calls instead of API credits.
- **Architecture mismatch to respect:** the Agent SDK owns its *own* agentic tool loop. It is **not**
  a drop-in transport for `client.messages.stream()`. So we don't swap the transport inside
  `runAnthropicLoop`; we add a *new* provider loop (`runClaudeCodeLoop`) that hands the loop to the SDK.
- **Tool parity is the hard part.** All of Aperio's value-add (failure budget, post-write validation,
  download cards, `recall_result`/`ttl_chip` events) lives in `callToolHooked`
  (`lib/agent/index.js:410`). To keep it, we expose Aperio's tools to the SDK as an **in-process SDK
  MCP server** whose handlers delegate to `callToolHooked` — *not* by pointing the SDK at the stdio
  MCP server directly. (See §4, option **A**.)
- **Recommended rollout:** v1 = stateless per-turn `query()` with a rendered transcript; v2 = SDK
  session `resume` for native context + lower token cost (see §6).

---

## 1. Critical: auth, billing, and the June 15 2026 change

From the official docs (verified May 2026):

1. **Package:** `@anthropic-ai/claude-agent-sdk`. The TS package bundles a native Claude Code binary
   as an optional dep — no separate Claude Code install required.
2. **Subscription auth works for personal use.** If the machine running Aperio is logged into Claude
   Code (`claude` login) with a Pro/Max plan, or has a token from `claude setup-token`
   (`CLAUDE_CODE_OAUTH_TOKEN`), the SDK draws on the subscription. This is exactly the "more time"
   benefit the user wants.
3. **⚠️ Billing model change — June 15 2026 (specifics confirmed).** Before this date, Agent SDK /
   `claude -p` usage counted against the *same* pool as interactive Claude Code / claude.ai chat.
   After it, that usage **no longer counts toward interactive limits** and instead draws from a
   **separate monthly Agent SDK credit** (dollar-denominated, billed at standard API rates):

   | Plan | Monthly Agent SDK credit |
   |---|---|
   | Pro | $20 |
   | Max 5× | $100 |
   | Max 20× | $200 |

   Drain order: the monthly credit is consumed first; when it runs out, usage **flows to API billing
   only if "usage credits" are enabled**, otherwise **requests stop until the credit refreshes**.
   Interactive limits stay reserved for interactive use.

   **Implications for this feature:**
   - No architectural change — subscription auth still works; build the loop as planned.
   - The credit is billed at **API rates**, so **model choice controls how far it stretches** — see the
     model-tier guidance below.
   - `result.total_cost_usd` is now meaningful — optionally track/surface cumulative spend vs. the
     monthly credit.
   - "Credit exhausted" is a real terminal state (requests stop if usage credits aren't enabled) — the
     loop's error path should surface it distinctly, not as a generic failure.

### 1.1 Model tiers (cost vs. reliability)

Prices (per MTok, May 2026 — billed at standard API rates, which is how the credit is metered):

| Model | Input | Output | Cache read | Note |
|---|---|---|---|---|
| Haiku 4.5 | $1 | $5 | $0.10 | cheapest |
| Sonnet 4.6 | $3 | $15 | $0.30 | — |
| Opus 4.8 | $5 | $25 | $0.50 | new tokenizer ≈ +35% tokens → ~2.2× Sonnet effective |

**Do not make Haiku the main agent driver.** Aperio is tool-heavy and edits real files; the
failure-budget + post-write-validation machinery (`callToolHooked`, `index.js:410`) and the
`project_deepseek_rewrite_issue` memory both exist because weak models emit malformed tool-call JSON and
corrupt files, which triggers retry loops that *waste* credit. A weak-but-cheap driver is a false
economy here.

Recommended tiering (map model to call site):

| Call site | Model | Config |
|---|---|---|
| Main chat loop (`runClaudeCodeLoop`) | **Sonnet 4.6** | `ANTHROPIC_MODEL` default for `claude-code` |
| Background `complete()` (summaries, inference) | **Haiku 4.5** | add `APERIO_COMPLETE_MODEL` (else it inherits `ANTHROPIC_MODEL`) |
| Greeting | **Haiku 4.5** | low stakes |
| Hard turns (multi-file edits, codegraph, pptx) | **Opus 4.8 on demand** | escalate only when Sonnet struggles |

**Bigger token lever than the model:** prompt caching (cache read = 10% of input) on Aperio's large,
repeated system prompt (whoami + persona + skills) — the Agent SDK applies it automatically. Combined
with v2 session resume (§6) and the existing on-demand tool loading, this dominates the per-turn cost.
Keep responses tight (output is 5× input price on every model).
4. **ToS boundary.** Anthropic does **not** permit third-party developers to *offer claude.ai login or
   subscription rate limits to their own end users* through Agent-SDK-powered products (without prior
   approval). Running **your own Aperio on your own subscription** is fine — that is the intended use.
   Do **not** ship this mode to other people on your plan.
5. **The `ANTHROPIC_API_KEY` trap.** If `ANTHROPIC_API_KEY` is present in the SDK subprocess
   environment, the SDK will use **API billing**, defeating the whole point. The provider **must run
   the SDK with `ANTHROPIC_API_KEY` scrubbed** from its environment (see §5, step 3) and rely on the
   logged-in credentials / `CLAUDE_CODE_OAUTH_TOKEN`.

**Verification checklist (do first, at implementation time):**
- [ ] Confirm the June 15 2026 credit model and current per-plan Agent SDK limits.
- [ ] Confirm precedence when both `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` are set.
- [ ] Confirm whether `Options` exposes an `env` field for per-`query()` env scoping (preferred over
      mutating `process.env`). The docs mention "50+ other options"; verify the exact name.
- [ ] `node -v` is v26 here — fine. Confirm SDK min Node.

---

## 2. How Aperio talks to Claude today (audit)

### 2.1 Provider resolution — `lib/providers/index.js`
- `resolveProvider({name, model})` returns a provider descriptor. For Anthropic (`index.js:40`):
  ```js
  return { name: "anthropic", model: ANTHROPIC_MODEL,
           client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
           ollamaBaseURL: OLLAMA_BASE_URL, contextWindow: 200000 };
  ```
- Provider names today: `anthropic | ollama | deepseek | gemini`. We add `claude-code`.

### 2.2 Agent construction — `lib/agent/index.js`
- `createAgent()` (`index.js:121`) is the single entry. It:
  - spawns the **stdio MCP server** (`mcp/index.js`) and lists tools (`index.js:164-167`);
  - builds per-provider tool schemas: `anthropicToolsAll`, `ollamaToolsAll`, `geminiDeclsAll`
    (`index.js:168-170`);
  - builds the layered system prompt via `getSystemPrompt()` (`index.js:247`) — whoami + persona +
    character + per-turn skills + provider tag + language directive;
  - does **on-demand tool loading** per turn via `classifyProfiles()` / `resolveToolNames()`
    (`index.js:57`, `:273`) — only a subset of tools is offered per user message;
  - exposes `callTool(name,input)` (`index.js:292`) → `mcp.callTool(...)`, normalizing text/image
    results into Anthropic-style content blocks;
  - in `runAgentLoop` (`index.js:335`) wraps `callTool` as **`callToolHooked`** (`index.js:410`) which
    adds: failure budget (3 strikes → hard abort message), `parseArgs`/post-write validation,
    `generated_file` download cards, `recall_result` + `ttl_chip` events, pptx artifact surfacing;
  - dispatches by provider name (`index.js:524-527`):
    ```js
    if (provider.name === "anthropic") return runAnthropicLoop(...);
    if (provider.name === "gemini")    return runGeminiLoop(...);
    if (provider.name === "deepseek")  return runDeepSeekLoop(..., getAbort, setAbort, ...);
    return runOllamaLoop(..., getAbort, setAbort, ...);
    ```
  - returns final assistant text (string).

### 2.3 The reference loop — `lib/agent/providers/anthropic.js`
- `runAnthropicLoop(messages, emitter, opts, ctx)` opens `provider.client.messages.stream(...)`, then
  maps the **Beta raw stream events** to emitter events:
  - `content_block_delta` / `text_delta` → `emitter.send({ type:"token", text })`
  - tool_use block start → `emitter.send({ type:"tool", name })`
  - on `message_start`/`message_delta` it captures `usage`
  - at end → `emitter.send({ type:"stream_end", text, usage })`
  - then executes `tool_use` via `ctx.callTool` (which is `callToolHooked`) and loops.
- **Key insight for the SDK provider:** the Agent SDK's `SDKPartialAssistantMessage`
  (`type:"stream_event"`) wraps the *same* `BetaRawMessageStreamEvent` shape. So the token/tool
  mapping below is nearly identical to this file.

### 2.4 Emitter contract — `lib/emitters/wsEmitter.js`
- `emitter.send(obj)` → `ws.send(JSON.stringify(obj))`. That's the whole contract.
- Event `type`s the UI consumes (from a full grep): `stream_start`, `token`, `tool`, `stream_end`
  (`{text, usage}`), `reasoning_start`/`reasoning_token`/`reasoning_done`, `context_trimmed`,
  `tool_failure`, `tool_budget_exhausted`, `recall_result`, `ttl_chip`, `generated_file`,
  `context_warning`, `context_handoff_suggested`, `error`.
- `usage` shape used everywhere: `{ input_tokens, output_tokens, thinking_tokens }`.

### 2.5 Call sites that must keep working
- `lib/emitters/handlers/wsHandler.js` — main chat (`:152`, `:357`), summarize (`:384`), handoff
  (`:471`), workspace (`:541`). Calls `runAgentLoop(messages, emitter, opts, getAbort, setAbort)`.
- `lib/terminal.js` — CLI chat (`:791`), greeting (`:816`), summary (`:675`).
- `lib/workers/roundtable.js:279` — two agents over one socket (tagged emitters).
- `lib/helpers/completion.js` — **non-streaming, non-tool** single-turn `complete()` used by background
  workers. Has its own per-provider branch and must gain a `claude-code` branch (see §7).
- `server.js:362` builds the shared agent at boot; `createAgent` is called **once** and shared across
  WS connections (relevant to the session strategy in §6).

---

## 3. The Agent SDK surface we will use (verified)

```ts
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const q = query({
  prompt,                       // string | AsyncIterable<SDKUserMessage>
  options: {
    model,                      // e.g. process.env.ANTHROPIC_MODEL
    systemPrompt,               // string (pass Aperio's getSystemPrompt output)
    mcpServers: { aperio: sdkServer },
    allowedTools,               // string[] — auto-approve (no prompts)
    disallowedTools,            // string[] — block built-ins
    canUseTool,                 // (name, input, {signal,...}) => PermissionResult
    includePartialMessages: true,  // REQUIRED for token-level streaming
    maxTurns,
    permissionMode: "default",  // or "bypassPermissions" for headless
    // env?: Record<string,string>  // verify name; use to scrub ANTHROPIC_API_KEY
    settingSources: [],         // do NOT auto-load ~/.claude/* unless wanted
  },
});
```

- `query()` returns `AsyncGenerator<SDKMessage>` + methods `.interrupt()`, `.setModel()`, `.close()`.
- **Message types** to handle in the loop:
  - `type:"system"`, `subtype:"init"` → capture `session_id` (for v2 resume); emit nothing or
    `stream_start`.
  - `type:"stream_event"` (only with `includePartialMessages:true`) → `.event` is a
    `BetaRawMessageStreamEvent`. Map exactly like `anthropic.js`:
    - `content_block_delta` + `text_delta` → `{type:"token", text}`
    - `content_block_start` tool_use → `{type:"tool", name}`
  - `type:"assistant"` → full assistant message (`.message` is a `BetaMessage`); use to accumulate
    final text if not streaming partials.
  - `type:"result"` → `{ subtype, result, usage, total_cost_usd, num_turns }`. Final answer + usage.
- **In-process tools:**
  ```ts
  const t = tool(name, description, zodShape, async (args) => ({ content: [{type:"text", text}] }));
  const sdkServer = createSdkMcpServer({ name: "aperio", version, tools: [...] });
  ```
  Tool names become `mcp__aperio__<name>` for `allowedTools`/`canUseTool`.

---

## 4. The tool-parity decision (most important design choice)

The SDK runs the tool loop itself. Two ways to give it Aperio's tools:

### Option A — in-process SDK MCP server delegating to `callToolHooked` ✅ RECOMMENDED
Wrap each of Aperio's `mcpTools` as an SDK `tool()` whose handler calls Aperio's existing
`callToolHooked(name, input)` and returns the result as `{ content: [...] }`.

- **Pros:** keeps the *entire* hook pipeline — failure budget, post-write validation, download cards,
  `recall_result`/`ttl_chip` emitter events, pptx surfacing. Behavior matches the other providers.
- **Cons:** more wiring; must convert MCP `inputSchema` (JSON Schema) → Zod shape for `tool()` (or use
  a permissive `z.object({}).passthrough()` and validate inside the handler — simpler, recommended for
  v1 since validation already happens server-side in the real MCP tools).
- The handler must translate Aperio's return (string **or** array of `{type:"text"|"image"}` blocks,
  per `callTool` at `index.js:307-315`) into the SDK `CallToolResult` `{content:[...]}` shape.

### Option B — point the SDK at the stdio MCP server directly
`mcpServers: { aperio: { command: "node", args: ["mcp/index.js"], env } }`.

- **Pros:** trivial wiring; reuses the real MCP server.
- **Cons:** tool calls **bypass `callToolHooked`** → lose the failure budget, post-write validation,
  download cards, and the `recall_result`/`ttl_chip` UI events. Some could be re-created via SDK
  `PostToolUse` hooks, but the *result-rewriting* behaviors (e.g. injecting "POST-WRITE VALIDATION
  FAILED" back into the tool result) don't map cleanly to hooks. **Not recommended** if parity matters.

**Decision:** implement **Option A**. Keep Option B noted as a fast spike to validate auth/streaming
before doing the full wrapping.

### Built-in tools
The SDK ships Claude Code's own `Read/Write/Edit/Bash/Glob/Grep/WebSearch/...`. Aperio must **not** let
the model use those (they bypass Aperio's sandboxed scratch dir, validation, and tool-loading policy).
Enforce by: `allowedTools = [<the mcp__aperio__* names for this turn>]` **and** a `canUseTool` callback
that **denies** any tool not in that set (and/or `disallowedTools` listing the built-ins). Verify denial
actually blocks rather than prompts.

---

## 5. Implementation steps

### Step 1 — dependency
```
npm install @anthropic-ai/claude-agent-sdk
```

### Step 2 — `resolveProvider` (`lib/providers/index.js`)
Add a branch before the anthropic default:
```js
if (PROVIDER === "claude-code") {
  return {
    name: "claude-code",
    model: ANTHROPIC_MODEL,            // reuse ANTHROPIC_MODEL; SDK accepts model ids/aliases
    client: null,                       // SDK is invoked in the loop, no Anthropic client
    ollamaBaseURL: OLLAMA_BASE_URL,     // keep for VLM image bridge parity if needed
    contextWindow: 200000,
  };
}
```
Note: returning `client: null` is safe because the dispatch in `index.js` routes `claude-code` to the
new loop, which never touches `provider.client`.

### Step 3 — new loop `lib/agent/providers/claude-code.js`
Signature mirrors anthropic (no getAbort/setAbort needed unless wiring interrupt — recommended to
accept them like deepseek so abort works):
```js
export async function runClaudeCodeLoop(messages, emitter, opts = {}, getAbort, setAbort, ctx) { ... }
```
Responsibilities:
1. Resolve the active user text (last user message) and call `ctx.getSystemPrompt(text, opts.lang,
   opts.extraSystem, messages)` for the system prompt, and `ctx.getAnthropicTools(text, messages)` to
   get the per-turn tool subset (reuse the existing resolver; the names map to `mcp__aperio__<name>`).
2. Build the in-process SDK MCP server (Option A): for each resolved tool, a `tool()` whose handler
   does `const r = await ctx.callTool(name, input); return toSdkResult(r);`. `ctx.callTool` here is
   `callToolHooked` (already wrapped by `runAgentLoop`).
3. Compose the `prompt` (see §6 for v1 vs v2).
4. **Scrub auth:** ensure the SDK subprocess does not see `ANTHROPIC_API_KEY`. Prefer
   `options.env = { ...process.env, ANTHROPIC_API_KEY: undefined }` if the option exists; otherwise
   document that the operator must run Aperio without `ANTHROPIC_API_KEY` in env for this provider.
5. `emitter.send({type:"stream_start"})`, then `for await (const msg of q)`:
   - `system/init` → capture `session_id`.
   - `stream_event` → map raw events to `{type:"token"}` / `{type:"tool"}` (copy logic from
     `anthropic.js:43-61`).
   - `result` → `emitter.send({type:"stream_end", text: msg.result, usage: mapUsage(msg.usage)})`;
     `return msg.result`.
   - On `getAbort()?.signal?.aborted` → `await q.interrupt()`, emit `stream_end`, return "".
6. `mapUsage(u)` → `{ input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0,
   thinking_tokens: 0 }`. (Usage comes straight from the SDK `result`; no token estimation needed.)
7. Errors: mirror deepseek's pattern — emit `stream_start` + a `⚠️` token + `stream_end`, return the
   message, never throw past the loop.

### Step 4 — dispatch (`lib/agent/index.js`)
- Import `runClaudeCodeLoop`.
- Add before the anthropic branch (`index.js:524`):
  ```js
  if (provider.name === "claude-code")
    return runClaudeCodeLoop(messages, emitter, opts, getAbort, setAbort, hookedCtx);
  ```
- `greetingToolCount` / `getToolCount`: treat `claude-code` like `anthropic` (uses
  `FIRST_TURN_TOOLS`). Update the `provider.name === "anthropic" || ...` check at `index.js:322`.
- `providerTag` (`index.js:144`): add a `claude-code` label, e.g. `Anthropic Claude via subscription
  (<model>)`, so "which model are you" answers correctly.

### Step 5 — `complete()` (`lib/helpers/completion.js`)
Add a `claude-code` branch: a single `query()` with `maxTurns: 1`, no MCP servers, `allowedTools: []`,
collect the `result` message's `.result` and return it. (Background workers must not silently fall
through to the API path.)

### Step 6 — config / docs
- `package.json` scripts: optional `start:sub` → `AI_PROVIDER=claude-code node server.js`.
- README/env docs: document `AI_PROVIDER=claude-code`, the login/`setup-token` step, and the
  ANTHROPIC_API_KEY scrubbing requirement.

---

## 6. Conversation / session strategy

`runAgentLoop(messages, ...)` is **stateless per call** and `createAgent` is shared across connections
(`server.js:362`), so we can't stash per-conversation SDK state on the agent instance safely.

- **v1 (recommended, zero signature changes):** one fresh `query()` per `runAgentLoop` call. Build
  `prompt` from `messages`: render prior turns into a compact transcript prepended to the latest user
  message (or fold the transcript into `systemPrompt` and pass only the latest user text as `prompt`).
  This mirrors the "resend whole history" behavior of the other loops; cross-turn structured tool
  history is flattened to text (acceptable for a memory-chat assistant — within-turn tool calls are
  fully handled inside the single query).
- **v2 (optimization):** use SDK `resume` with a `session_id` captured from the `system/init` message.
  Requires threading a `sessionId` in/out through `opts` and storing it in the **wsHandler
  per-connection state** (not the shared agent). Saves tokens and preserves native context. Defer
  until v1 works.

Do **not** attempt to inject prior assistant turns as `SDKUserMessage`s — the SDK reconstructs
assistant context from its own session, not from injected user messages.

---

## 7. Known parity gaps to call out (and how to handle)

| Aperio feature | Status under SDK | Action |
|---|---|---|
| Failure budget, post-write validation, download cards, `recall_result`/`ttl_chip` | Preserved via Option A (`callToolHooked`) | none |
| On-demand per-turn tool loading | Preserved (resolve subset once per turn, pass as `allowedTools`) | none |
| Token-level streaming | Preserved via `includePartialMessages:true` | none |
| `usage` numbers | From SDK `result.usage` (real, not estimated) | map fields |
| Context trimming (`trimByTokens`, `MAX_HISTORY`) + `context_trimmed`/`context_warning` events | SDK manages its own context/compaction | accept divergence; don't emit those events, or synthesize from `result` if needed |
| Reasoning/thinking events (`reasoning_*`) | Not emitted by default | optional: map thinking deltas from stream_event if present |
| Image inputs / VLM bridge | SDK accepts image content blocks natively | pass through; verify |
| `getAbort/setAbort` cancel | Map to `q.interrupt()`/`q.close()` | wire in step 3 |
| Round-table (two agents) | Each agent = its own `query()`; tagged emitters still work | verify concurrency |

---

## 8. Test plan (success criteria)

1. **Auth:** with `AI_PROVIDER=claude-code` and **no** `ANTHROPIC_API_KEY` in env, a chat turn
   completes and usage appears on the subscription dashboard (not API console).
2. **Streaming:** tokens stream into the UI (not one dump at the end) — confirms
   `includePartialMessages` + mapping.
3. **Tools:** a "remember that X" / "recall" turn fires `recall_result`/`ttl_chip` and a tool runs via
   `callToolHooked` (verify by logging inside the wrapper).
4. **Validation hook:** force a bad write and confirm the POST-WRITE VALIDATION message still appears
   (proves Option A wiring).
5. **Download card:** generate an xlsx/pptx and confirm `generated_file` still emits.
6. **Built-ins blocked:** prompt "run `ls` with Bash" and confirm the SDK's built-in Bash is denied.
7. **Fallback intact:** `AI_PROVIDER=anthropic` (API key) still works unchanged.
8. **complete():** a background worker path returns text under `claude-code`.

---

## 9. File-change summary (for the implementer)

- `package.json` — add `@anthropic-ai/claude-agent-sdk`; optional `start:sub` script.
- `lib/providers/index.js` — `claude-code` branch in `resolveProvider`.
- `lib/agent/providers/claude-code.js` — **new**: `runClaudeCodeLoop` + in-process MCP wrapper +
  stream→emitter mapping.
- `lib/agent/index.js` — import + dispatch branch (`:524`), greeting/tool-count checks (`:322`),
  `providerTag` (`:144`).
- `lib/helpers/completion.js` — `claude-code` branch.
- docs/README/env — usage + auth + ANTHROPIC_API_KEY scrubbing note.

Reference loop to copy stream-mapping from: `lib/agent/providers/anthropic.js`. Hook pipeline to
delegate into: `callToolHooked` at `lib/agent/index.js:410`.

---

## 10. Open questions to resolve at implementation time

1. Exact `Options` field for per-`query()` env (to scrub `ANTHROPIC_API_KEY` without mutating global
   `process.env`). If none, decide between mutating env around the call vs. requiring operator setup.
2. `CLAUDE_CODE_OAUTH_TOKEN` vs logged-in credentials vs `ANTHROPIC_API_KEY` precedence.
3. June 15 2026 Agent SDK credit limits per plan — does the user's plan have enough monthly credit for
   their Aperio usage pattern?
4. Whether to keep v1 transcript approach or jump straight to v2 session resume (token cost).
5. JSON-Schema→Zod conversion for `tool()` vs permissive passthrough (recommend passthrough for v1).

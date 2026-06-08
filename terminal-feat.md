# Aperio Terminal — Feature Gap Audit & Blueprint

> Audit date: 2026-06-08
> Status: The terminal client provides a working chat loop but is missing ~60% of the WebSocket path's event surface and several critical UX capabilities.

---

## 1. Architecture: Two Paths, One Agent

```
                    ┌──────────────────────────────────┐
                    │        createAgent()              │
                    │   (lib/agent/index.js)            │
                    │   Provider loops, tool exec,      │
                    │   context trim, memory preload    │
                    └──────────┬───────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              │                                 │
    ┌─────────▼──────────┐          ┌──────────▼──────────┐
    │  WebSocket Path     │          │  Terminal Path       │
    │  wsHandler.js       │          │  terminal.js         │
    │  wsEmitter.js       │          │  cliEmitter.js       │
    │  + frontend UI      │          │  + readline + ANSI   │
    └────────────────────┘          └─────────────────────┘
         Full-featured                  Minimal — gaps below
```

Both paths call the same `createAgent()` → `runAgentLoop()`. The divergence is entirely in the emitter layer and the wrapper logic around it.

---

## 2. Event Surface: What's Missing in the Terminal

The agent loop emits **30+ distinct event types** through the emitter interface. The CLI emitter handles only 10 of them.

### Handled (cliEmitter.js)

| Event | Terminal behavior |
|---|---|
| `stream_start` | Stops spinner silently |
| `token` | Buffered in memory, rendered at `stream_end` |
| `stream_end` | Renders full answer via markdown→ANSI |
| `tool` | Prints dim badge with spinner while tool runs |
| `reasoning_start` | Gated by `--reasoning` flag, prints thinking block |
| `reasoning_token` | Streams dim reasoning text |
| `reasoning_done` | Closes thinking block |
| `retract` | Clears answer buffer |
| `thinking` | Starts spinner |
| `error` | Prints red error line |

### Not Handled — Swallowed Silently

These events are emitted by the agent loop or wsHandler but the cliEmitter has no case for them:

| Event | What it carries | Impact of missing it |
|---|---|---|
| `status` | Connection acknowledgment | Terminal shows no "connected" confirmation |
| `provider` | Model name, thinks flag, context window, image tokens, roundtable agents | Terminal can't auto-detect thinking models; model badge never updates |
| `preload_mem_count` | Number of memories preloaded into system prompt | User doesn't know memory context exists |
| `startup_breakdown` | Token cost breakdown (identity, skills, memories) | No visibility into prompt cost |
| `tool_count` | How many tools were loaded for this turn | User can't see tool activation |
| `tool_start` | Per-tool execution start with `seq`, argument summary, timing | Can't track individual tool calls in a batch |
| `tool_result` | Tool outcome with `ok`/`summary`/`ms` | No per-tool success/failure feedback |
| `tool_budget_exhausted` | Failure budget hit with root-cause breakdown | Terminal gets no warning when the model is thrashing |
| `context_warning` | 60% context pressure | Terminal can't warn about approaching context limits |
| `context_handoff_suggested` | 72% handoff suggestion | Terminal can't suggest `/compact` or handoff |
| `context_trimmed` | Messages dropped to stay under token budget | User never knows history was truncated |
| `recall_result` | Memory recall results during conversation | Terminal can only show memories via explicit command, not inline |
| `ttl_chip` | Expiring memory chip (TTL set on remember) | No visibility into memory expiry |
| `delete_confirm_pending` | File deletion token awaiting user confirmation | Deleting files silently fails |
| `skills_matched` | Which skills were activated for this turn | User can't see skill activation |
| `generated_file` | Download card for generated xlsx/docx/pptx | Terminal can't surface download links |
| `context_summarized` | Result of summarize operation | No confirmation that summary was saved |
| `handoff_written` | Handoff markdown written to disk | No feedback after handoff |
| `suggestions_saved` | Memory suggestions persisted | No feedback |

### Not Implemented — Feature Gaps (wsHandler capabilities with no terminal equivalent)

| Feature | WebSocket path | Terminal gap |
|---|---|---|
| **Model switching at runtime** | `switch_model` message → `agent.setProvider()` | Terminal can only pick model at startup; can't switch mid-session |
| **Attachment uploads** | Images + files via `processAttachments()` → content blocks | Terminal has no file input mechanism |
| **Session resume** | `resume_session` → `getSession()` + `buildResumeContext()` | Terminal has no session picker or resume flow |
| **Round-table deliberation** | `runRoundTable()` with dual agents | Terminal is single-agent only |
| **Handoff generation** | `handleHandoff()` → write to `var/handoffs/` | Terminal has no handoff command |
| **Memory suggestions** | `save_suggestions` → parse + store | Terminal has no suggestion flow |
| **Context pressure UI** | Warning banner, handoff banner, trimmed banner with actions | Terminal has flat output; no contextual alerts |
| **Live tool cards** | `tool_start`/`tool_result` → cards with timing | Terminal only shows a single spinner per tool |
| **Generated file download** | `generated_file` → attachment card with download button | Terminal can't surface file paths or download links |
| **Token badges** | Per-message token counts annotated in UI | Terminal has no token accounting |
| **Code syntax highlighting** | Prism.js with language detection | Terminal only does basic ANSI fenced blocks |
| **Voice/TTS** | TTS integration via `public/scripts/tts.js` | Terminal has no speech output |

---

## 3. Terminal-Specific Advantages

The terminal path has capabilities the Web UI doesn't:

| Feature | Description |
|---|---|
| **Standalone mode** | No server needed — boots the agent directly in-process |
| **Ollama model picker** | Interactive model selection + pull at startup |
| **ANSI markdown renderer** | Fenced code blocks, headings, bold/italic, inline code, bullets |
| **Ctrl+C abort** | Single-press aborts generation, double-press exits |
| **`remember that` command** | Natural-language memory saving shortcut |
| **`forget <id>` command** | Direct memory deletion by ID |
| **Header bar** | Fixed model name and reasoning toggle in scroll region |
| **Scroll regions** | Chat history in scrollable region above input |

These should be preserved and extended, not replaced.

---

## 4. Gap Severity Triage

### P0 — Broken or silently failing

| # | Gap | What happens today |
|---|---|---|
| 1 | **`tool_budget_exhausted` not handled** | When the model produces 3 bad tool calls in a row, the agent stops and returns a detailed error. The terminal never displays it — the user just sees a dead spinner. |
| 2 | **`generated_file` not handled** | When a skill generates an xlsx/docx/pptx, the terminal receives the file path but silently drops it. The user has no way to know the file exists or where to find it. |
| 3 | **`delete_confirm_pending` not handled** | File deletion requires user confirmation via a token exchange. The terminal never shows the token, so deletes silently fail. |
| 4 | **`context_trimmed` not handled** | The agent drops messages to stay under token budget, but the terminal never tells the user. They may wonder why the agent "forgot" earlier context. |

### P1 — Missing but non-blocking

| # | Gap | What happens today |
|---|---|---|
| 5 | **`context_warning` / `context_handoff_suggested` not handled** | Long sessions degrade silently. User has no signal to `/compact` or handoff. |
| 6 | **`skills_matched` not handled** | Skills load on-demand, but the terminal user never sees which ones activated. Makes debugging prompt behavior hard. |
| 7 | **`recall_result` not handled** | The model recalls memories mid-conversation, but the terminal user doesn't see them inline. Only the explicit `memories` command shows them. |
| 8 | **`tool_start` / `tool_result` not handled** | Batch tool calls (e.g., 3 parallel reads) all show the same spinner. No per-tool status or timing. |
| 9 | **`ttl_chip` not handled** | When the model saves a time-bound memory, the user doesn't know it will expire. |

### P2 — Feature gaps (exist in Web UI, missing in terminal)

| # | Gap |
|---|---|
| 10 | **Runtime model switching** — `switch_model` message |
| 11 | **Attachment uploads** — images, PDFs, text files |
| 12 | **Session resume** — `resume_session` |
| 13 | **Round-table mode** — two-agent deliberation |
| 14 | **Handoff generation** — write context document to disk |
| 15 | **Memory suggestions** — auto-detected memory-worthy facts |
| 16 | **Token badges** — per-message token counts |
| 17 | **Context pressure banner** — dismissable inline alerts |
| 18 | **Download buttons** — for generated artifacts |

### P3 — Nice to have

| # | Gap |
|---|---|
| 19 | **Attachment previews** — image descriptions, PDF summaries |
| 20 | **Voice/TTS** — speech synthesis |
| 21 | **Session list** — browse and resume past sessions |
| 22 | **Wiki browsing** — interactive wiki article viewer |

---

## 5. Implementation Plan

### Phase 1 — Wire the Missing Events (P0, low effort)

**Goal**: The CLI emitter handles every event the agent loop emits. No more swallowed events.

**Where**: `lib/emitters/cliEmitter.js` (add ~10 cases), `lib/terminal.js` (expose helpers)

**What**:
- Add cases for `tool_budget_exhausted`, `generated_file`, `delete_confirm_pending`, `context_trimmed`, `context_warning`, `context_handoff_suggested`
- Add cases for `tool_start`, `tool_result` (compact one-line per tool with timing)
- Add cases for `skills_matched` (dim line listing skill names)
- Add cases for `recall_result`, `ttl_chip`
- Add case for `provider` (update header model after runtime switch)
- Add case for `tool_count`, `preload_mem_count`, `startup_breakdown`

**Design principle**: Terminal-friendly formatting. No interactive buttons — just clear text lines.

**Fallback pattern**: Handle unknown event types with a dim `[unhandled: type]` line so future events don't silently vanish.

### Phase 2 — Context Pressure & Summarization (P0/P1, low effort)

**Goal**: The terminal user has parity with the Web UI for context management.

**Where**: `lib/terminal.js` (add `summarize` + `handoff` commands), `lib/emitters/cliEmitter.js`

**What**:

**2a. `summarize` command (already exists in standalone)**
- Port the standalone `handleSummarize()` to the proxy mode as well.
- Proxy sends `{ type: "summarize" }` → wsHandler processes it → returns `context_summarized` event.
- CLI emitter renders the result.

**2b. `handoff` command**
- Add `/handoff [focus]` slash command.
- Sends `{ type: "handoff", focus }` to wsHandler.
- wsHandler generates handoff doc, returns `handoff_written`.
- Terminal prints the file path.

**2c. Context pressure display**
- On `context_warning`: print dim `⚠ context: N% used` line after the answer.
- On `context_handoff_suggested`: print `⟳ context: N% — consider /handoff or /summarize`.
- On `context_trimmed`: print `✂ dropped N old messages (N% pressure)`.

### Phase 3 — Runtime Model Switching (P2, medium effort)

**Goal**: Switch models without restarting the terminal.

**Where**: `lib/terminal.js` (both proxy and standalone)

**What**:
- Add `/model <provider> <name>` slash command.
- Proxy: sends `{ type: "switch_model", provider, model }`.
- Standalone: calls `agent.setProvider({ name, model })` directly.
- Re-announces provider via `provider` event → header updates.

### Phase 4 — File Attachments (P2, medium effort)

**Goal**: Send images, PDFs, and text files from the terminal.

**Where**: `lib/terminal.js` (add `/attach` command and paste support)

**What**:
- `/attach <path>` — reads a local file, base64-encodes it, sends via WebSocket.
- Paste support: if clipboard content starts with image data URL or a known binary header, detect and send as attachment.
- For standalone mode: inject as content block directly into `messages[]`.
- Terminal prints a one-line confirmation: `📎 attached: filename.png (1.2 MB)`.

### Phase 5 — Session Resume (P2, low effort)

**Goal**: Resume a previous session from the terminal.

**Where**: `lib/terminal.js` (add `/resume <id>` command), `lib/helpers/sessions.js` (list sessions)

**What**:
- `/sessions` — lists recent sessions with IDs, titles, dates.
- `/resume <id>` — sends `{ type: "resume_session", id }` to wsHandler.
- wsHandler injects `buildResumeContext(session)` into the system prompt.
- Terminal receives `session_resumed` event and prints confirmation.

### Phase 6 — Round-Table Mode (P2, medium effort)

**Goal**: Enable two-agent deliberation from the terminal.

**Where**: `lib/terminal.js` (add `/discuss` flag per-turn)

**What**:
- `/discuss on` / `/discuss off` — toggles roundtable mode for subsequent turns.
- When on, sends `{ type: "chat", text, roundtable: true }`.
- wsHandler routes through `runRoundTable()`.
- CLI emitter already handles the streaming events roundtable emits (`stream_start` with `agent_id`, `token`, `stream_end`).
- Add roundtable-specific rendering: phase chips (`[Answer]`, `[Review]`, `[Revise]`), agent labels (α/β), consensus verdict.

### Phase 7 — Token Accounting & Polish (P2/P3, low effort)

**Goal**: The terminal shows what the Web UI shows.

**Where**: `lib/emitters/cliEmitter.js`

**What**:
- After `stream_end`, print a dim footer with token counts when usage data is present:
  ```
  [1,234 in · 567 out · 89 think · 2.3s]
  ```
- On `tool_count`: show tool load indicator in header.
- On `preload_mem_count`: mention in greeting.
- Code block syntax highlighting: use ANSI color tokens for language keywords when possible.

---

## 6. Files to Create / Modify

```
Modified files:
  lib/emitters/cliEmitter.js      # Add handlers for all missing events (Phase 1, 2c, 7)
  lib/terminal.js                 # Add /model, /attach, /resume, /sessions, /handoff, /discuss commands (Phases 2-6)
  lib/utils/chat-utils.js         # Add helpers: printAttachConfirmation, modelPicker, sessionLister
  lib/emitters/handlers/wsHandler.js  # Ensure handoff/summarize work for proxy clients (Phase 2)

New files:
  lib/terminal/commands.js        # Slash-command parser and dispatcher (Phase 3-6)
  lib/terminal/attach.js          # File reader + base64 encoder (Phase 4)
  lib/terminal/session-picker.js  # Session list + resume flow (Phase 5)
  tests/lib/terminal/             # Terminal-specific tests
```

---

## 7. Quick Wins (Do First)

These are the highest-impact, lowest-effort changes:

1. **Add a default fallback case to `cliEmitter.send()`** — prints `[event: type]` for any unhandled event type. This single change makes all future agent loop events visible in the terminal and eliminates the "where did my file go?" class of silent failures. (~10 lines)

2. **Handle `generated_file`** — when the agent produces a file, print its path. The user manually opens it. (~15 lines in cliEmitter.js)

3. **Handle `tool_budget_exhausted`** — when the failure budget trips, print the error message. Currently the model stops and the spinner just dies. (~10 lines)

4. **Handle `context_trimmed`** — print a one-liner when messages are dropped. (~8 lines)

---

## 8. Success Criteria

- **Phase 1**: Zero unhandled event types in the terminal. Every agent loop event surfaces usefully.
- **Phase 2**: Terminal user can `/summarize` and `/handoff` with visible results. Context pressure is signaled.
- **Phase 3**: `ctrl+t` or `/model` switches the active model without restart.
- **Phase 4**: `/attach readme.md` sends the file as context. `/attach photo.jpg` sends the image.
- **Phase 5**: `/sessions` lists past sessions; `/resume abc123` continues where you left off.
- **Phase 6**: `/discuss on` enables round-table mode; terminal shows both agents' reasoning and final consensus.
- **Phase 7**: Every answer footer shows token counts and elapsed time.

---

*Generated from the 2026-06-08 side-by-side audit of `lib/emitters/cliEmitter.js` vs `lib/emitters/wsEmitter.js` + `lib/emitters/handlers/wsHandler.js` + `public/scripts/streaming.js`.*

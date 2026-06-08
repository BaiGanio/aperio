# Aperio Terminal — Remaining Gaps & Concerns

> Last updated: 2026-06-08 (audit after verifying current source)
> 
> The original `terminal-feat.md` audit identified ~60% missing event surface and multiple feature gaps.
> **As of this audit, nearly everything has been implemented.** cliEmitter.js handles all agent-loop
> event types (plus a `default` fallback), and terminal.js has `/model`, `/attach`, `/sessions`,
> `/resume`, `/handoff`, `/summarize`, `/forget`, `remember that`, and `discuss on/off` (proxy) in both
> proxy and standalone paths. Token footer rendering at `stream_end` is done. Context pressure events
> (`context_warning`, `context_handoff_suggested`, `context_trimmed`) are surfaced.
>
> Below are the only items that still need work or have uncertainty.

---

## 1. Round-Table Mode — Standalone Path Missing

**Status**: Proxy mode has `discuss on/off` (line 717 of `lib/terminal.js`), which toggles
`roundtableMode` and sends `{ roundtable: true }` with each chat message. The CLI emitter
already handles all round-table events (`roundtable_phase`, `roundtable_agreed`,
`roundtable_no_agreement`, `roundtable_aborted`, `roundtable_error`).

**Gap**: Standalone mode (`runStandalone`) has no `/discuss` command. The `promptUser` function
(lines 986–1153) does not include `isDiscussCommand()` in its dispatch. For standalone users,
there is no way to invoke the two-agent deliberation path.

**Concern**: Is standalone round-table even feasible? The agent loop `runRoundTable()` may need
a second agent instance. If the standalone path can construct a second agent (or if the round-table
abstraction is only available via the wsHandler path), this may be a server-only feature by design.
If so, the standalone command should surface that limitation rather than silently missing it.

**Action**: Verify whether the agent loop supports round-table in-process, and either:
- Add `discuss on/off` to standalone with the appropriate agent setup, or
- Surface a clear message: "discuss requires a running Aperio server."

---

## 2. Code Syntax Highlighting — Basic Cyan Rendering Only

**Status**: The `renderMarkdown` function in `cliEmitter.js` (lines 46–63) renders fenced code
blocks with a dim border and cyan text. No language-aware syntax highlighting is performed.

```
┌─ javascript
│ const x = 1;
└─
```

All lines inside the fence get the same `CYAN` color regardless of language or token type.

**Concern**: Building a proper ANSI syntax highlighter inline is non-trivial and may bloat the
emitter. The audit originally listed this as P3 (nice-to-have). The question is whether it's
worth the complexity.

**Options**:
- Accept the current cyan rendering as sufficient for a terminal client.
- Use a lightweight highlighter like `cli-highlight` or `highlight.js` with ANSI output (adds a dependency).
- Keep as-is and document the limitation.

---

## 3. Voice/TTS — Not Implemented

**Status**: The Web UI path has TTS integration (`public/scripts/tts.js`). The terminal has no
speech output, and no command or event handler for TTS.

**Concern**: This was rated P3 (nice-to-have) and likely low priority. However, visually impaired
users or users who prefer audio feedback have no terminal path for TTS. The architecture question
is whether TTS should be a client-side capability (spawning a local TTS process) or proxied
through the server.

**Action**: Decide whether to:
- Implement a local TTS command using `say` (macOS), `espeak` (Linux), or a WebSocket relay.
- Document that TTS is a Web UI-only feature and close this gap.

---

## 4. Planned File Splits — Logic Remains Inline

**Status**: The original audit proposed creating:
- `lib/terminal/commands.js` — slash-command parser and dispatcher
- `lib/terminal/attach.js` — file reader + base64 encoder
- `lib/terminal/session-picker.js` — session list + resume flow
- `tests/lib/terminal/` — terminal-specific tests

**Current state**: All slash-command logic lives inline in `lib/terminal.js` (1,189 lines).
Attachment parsing is `readAttachment()` at line 504. Session listing is `printSessions()` at
line 516. Tests exist in `tests/lib/terminal.test.js`.

**Concern**: The file is long but well-structured with clear function boundaries (`isXxxCommand`
predicates and `handleXxx` functions are separated). Extracting into separate files would improve
testability and reduce the single-file size, but the current structure is functional and clean.

**Action**: Low priority. Extracting to sub-files would be a refactoring exercise, not a feature gap.
Consider only if `lib/terminal.js` grows significantly beyond its current size.

---

## 5. Status Event — "Connected" Confirmation Silently Swallowed

**Status**: The `status` event from the agent loop is handled at `cliEmitter.js` line 406 with
a silent `break`. The `provider` event is intercepted in proxy mode (terminal.js line 580) to update
the header, and silently swallowed in standalone (cliEmitter.js line 407).

**Concern**: The terminal never shows a "connected" or "ready" confirmation after startup.
In proxy mode, the header initializes with the provider/model before the WebSocket opens; if
the server returns a different model than expected, the header may mismatch until a `provider`
event arrives.

**Action**: Consider having cliEmitter print a brief `status` line on first connection, e.g.,
`[connected to Aperio vX.Y.Z]`. Low priority since the header model is updated by the `provider`
event in proxy mode.

---

## 6. Quick Reference — What's Already Done (removed from this file)

For reference, the following items from the original audit are complete and require no further work:

- **P0**: `tool_budget_exhausted`, `generated_file`, `delete_confirm_pending`, `context_trimmed` — all handled in cliEmitter
- **P1**: `context_warning`, `context_handoff_suggested`, `skills_matched`, `recall_result`, `tool_start`, `tool_result`, `ttl_chip` — all handled
- **Informational**: `preload_mem_count`, `tool_count`, `startup_breakdown`, `context_summarized`, `handoff_written`, `suggestions_saved` — all handled
- **Round-table**: All round-table events (`roundtable_phase`, `_agreed`, `_no_agreement`, `_error`, `_aborted`) handled
- **Fallback**: Unknown event types print `[event: type]` instead of being silently swallowed
- **Proxy commands**: `/summarize`, `/handoff`, `/sessions`, `/resume <id>`, `/model <prov> <name>`, `/attach <path>`, `/discuss on|off`, `forget <id>`, `remember that`
- **Standalone commands**: Same as proxy except `/discuss` (see Gap #1 above)
- **Token footer**: `[N in · N out · N think · N.Ns]` rendered at `stream_end`
- **Session management**: Proxy sends `resume_session` to wsHandler; standalone calls `getSession()` + `buildResumeContext()` + `runAgentLoop()`
- **Attachment pipeline**: Both paths use `readAttachment()` → base64 encode; standalone also calls `processAttachments()` for full content-block resolution; proxy sends raw attachment data via WebSocket for server-side processing

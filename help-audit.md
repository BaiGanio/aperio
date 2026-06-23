> Last audited: **2026-06-23** (verified against live source at `0283b91`)
>
> **Executive summary**: Seven gaps total — five from the original audit (all
> still standing; terminal source unchanged since baseline) plus two found on the
> 2026-06-23 re-audit (Gaps 6 & 7). None are regressions or P0 blockers — the
> terminal is functional and stable. Two have user-visible impact: Gap 1
> (standalone round-table — "discuss on" silently falls through to chat) and
> Gap 6 (no `help` command — the entire command set is undiscoverable from
> inside the terminal). The rest are polish, deferred refactors, or test-quality
> cleanups. Below is the verified current state of each gap, followed by a
> phased execution plan for the next sprint.

---

## Verified Gap Status

### 1. Round-Table Mode — Standalone Path Missing (CONFIRMED)

**What the code says:**

| Aspect | Detail |
|---|---|
| `isDiscussCommand()` | Defined & exported at `lib/terminal.js:340`. Regex: `/^discuss(\s+(on\|off))?$/i`. Works correctly. |
| Proxy dispatch | `runProxy → promptUser()` at line **723** handles `isDiscussCommand(cmd)` — toggles `roundtableMode`, prints status, and sends `{ roundtable: true }` with next chat payload. **Working.** |
| Standalone dispatch | `runStandalone → promptUser()` at line **994** has NO `isDiscussCommand(cmd)` check. Dispatch order: exit → clear → memories → reasoning → summarize → handoff → sessions → resume → model → forget → attach → **falls through to regular chat** (line 1115). |
| `isSpecialCommand()` | Defined at line 254. Includes `isDiscussCommand(trimmed)` in its list. BUT this function is **never called at runtime** — only exported for tests. Dead code for dispatch purposes. |
| What happens when you type "discuss on" in standalone | It is NOT matched by any dispatch check. Falls through to line 1115 ("Regular chat message") and gets sent to the agent as if it were a user message. **Broken UX** — the model receives a nonsensical "discuss on" message. |
| Tests | Zero tests for `isDiscussCommand` or discuss dispatch in `tests/lib/terminal.test.js`. |

**Architecture assessment — is standalone round-table even feasible?**

`runRoundTable()` in `lib/workers/roundtable.js:329` requires:

- `primary` — an agent instance (from `createAgent()`)
- `verifier` — a SECOND agent instance
- `ws` — a raw WebSocket (used by `makeWsEmitter()` to send phase events)
- `sharedTranscript`, `userText`, etc.

Standalone mode calls `createAgent()` **once** (line 767). To support round-table,
it would need to:
1. Create a second agent instance (`createAgent()` is expensive — MCP transport,
   skill index load, provider resolution).
2. Either refactor `runRoundTable()` to accept a non-WebSocket emitter, or run a
   local WebSocket server. The function is tightly coupled to `makeWsEmitter(ws)`
   which writes to a WebSocket.
3. Handle independent message buffers per agent (already done in `runRoundTable`).

**Verdict**: Round-table is architecturally a **server-side feature**. Making it
work in standalone would require either a non-trivial refactor of `runRoundTable`
to decouple from WebSocket, or booting a local server from standalone mode. Both
are out of scope for a quick fix.

**Recommended action**: Add a `discuss on/off` handler to standalone `promptUser`
that surfaces a clear message: *"Round-table deliberation requires a running
Aperio server. Start the server with `aperio serve`, then reconnect the terminal."*

---

### 2. Code Syntax Highlighting — Basic Cyan Rendering Only (CONFIRMED)

**What the code says:**

`renderMarkdown()` in `lib/emitters/cliEmitter.js:36-103`:

- Fenced code blocks get a dim border: `┌─ javascript` / `└─`
- All lines inside get `CYAN` color (`\x1b[36m`), regardless of language or token type.
- No language-aware tokenization or syntax coloring.

Current rendering:
```
┌─ javascript
│ const x = 1;
└─
```

This is unchanged from the original audit. The renderer is clean and functional
but purely cosmetic for code blocks.

**Options (unchanged)**:
- Accept cyan-only as sufficient. Terminal users reading code blocks are likely
  developers who can parse the structure from indentation and monospace.
- Add `cli-highlight` or `highlight.js` with ANSI output (~50-100 KB dependency).
- Keep as-is and document.

**Recommendation**: P3 (nice-to-have). If done, prefer `highlight.js` with a
capped language set (js, python, bash, json, html, css, sql) to keep the
dependency footprint small. Estimate: **1-2 hours** to integrate and test.

---

### 3. Voice/TTS — Not Implemented (CONFIRMED)

**What the code says:**

- Zero references to `tts`, `speak`, `speech`, `voice`, `audio`, or `say` in
  `lib/terminal.js` (1197 lines) or `lib/emitters/cliEmitter.js` (419 lines).
- The Web UI has TTS via `public/scripts/tts.js` — terminal has nothing.
- No event type, no command, no configuration for TTS.

**Recommendation**: Document as a Web UI-only feature and close the gap. Terminal
TTS is a niche requirement. If ever implemented, the path of least resistance is
spawning the OS-native TTS binary (`say` on macOS, `espeak` on Linux) as a child
process with the answer text piped to stdin.

---

### 4. Planned File Splits — Logic Remains Inline (CONFIRMED)

**What the code says:**

```
Directory:   lib/terminal/       → DOES NOT EXIST
Main file:   lib/terminal.js     → 1197 lines (was 1189 at last audit)
Emitter:     lib/emitters/cliEmitter.js → 419 lines
Tests:       tests/lib/terminal.test.js (single file, not in subdirectory)
```

The original audit proposed:
- `lib/terminal/commands.js` — slash-command parser and dispatcher
- `lib/terminal/attach.js` — file reader + base64 encoder
- `lib/terminal/session-picker.js` — session list + resume flow
- `tests/lib/terminal/` — per-module terminal tests

**Current structure is clean but monolithic**:
- `isXxxCommand` predicates (lines 100-349) are individually exported and testable.
- `readAttachment()` (line 510) and `printSessions()` (line 522) are self-contained.
- `handleSummarize()` and `handleHandoff()` are well-scoped async functions.

The file grew by only 8 lines since the last audit. It is not bloating.

**Recommendation**: Defer until `lib/terminal.js` crosses ~1500 lines or a new
feature forces a split. If split is done, prioritize extracting `commands.js`
(dispatch logic) first — it's the largest self-contained concern (~200 lines
of predicate + dispatch). Estimate: **3-4 hours** for full split + test
reorganization.

---

### 5. Status Event — "Connected" Confirmation Silently Swallowed (CONFIRMED)

**What the code says:**

| Path | `status` event | `provider` event |
|---|---|---|
| Proxy | Goes to `cliEmitter.js:406` → silent `break` | Intercepted in `ws.on("message")` at `terminal.js:586` → updates header model. Also falls through to cliEmitter (`:407`) → silent `break`. |
| Standalone | Goes to cliEmitter → silent `break` (:406) | Goes to cliEmitter → silent `break` (:407) |
| cliEmitter handler | `case "status":` and `case "provider":` both have `break;` with no output (lines 405-410). |

The header initializes with the expected provider/model **before** the WebSocket
opens (proxy mode, line 611). If the server returns a different model, the
`provider` event updates it. But there is **never** a "connected" or "ready"
confirmation printed to the user.

**Recommendation**: Add a one-line status print in cliEmitter for the first
`status` event. Trivial change — 2 lines of code. Estimate: **15 minutes**.

---

## Additional Findings (re-audit 2026-06-23)

> The terminal source (`lib/terminal.js`, `lib/emitters/cliEmitter.js`) is
> **unchanged since the audit baseline `0283b91`** — verified via `git log`. The
> five gaps above all still stand verbatim. Two further gaps surfaced on this
> pass that the original audit did not capture:

### 6. No `help` / `?` Command — Zero In-Terminal Command Discovery (NEW)

There is no `isHelpCommand` predicate, no `help`/`?` dispatch case in either
`promptUser` path, and **no startup banner that lists commands** (confirmed by
grep — nothing prints the command set). A user typing `help` falls through to
line 1115 and the literal word "help" is sent to the model as a chat message.

The terminal has ten-plus slash-style commands (`discuss`, `handoff`, `attach`,
`model`, `sessions`, `resume`, `forget`, `summarize`, `memories`, `reasoning`,
`clear`, `exit`) and **none of them are discoverable from inside the terminal**.
The only way to learn they exist is to read external docs.

**Recommendation**: P2 — arguably higher user value than Gaps 2 (highlighting)
and 3 (TTS). Add an `isHelpCommand` (`/^(help|\?)$/i`) and a dispatch case in
both paths that prints the command list. The standalone and proxy command sets
differ slightly (proxy has working `discuss`; standalone will gate it per Gap
1.1), so the help text should be path-aware. Estimate: **30 min** + test.

### 7. Predicate/Dispatch Divergence Is Systemic (NEW — generalizes Gap 1)

Gap 1 noted `isSpecialCommand` is dead code for dispatch. The pattern is broader:
`isExitCommand`, `isClearCommand`, `isMemoriesCommand`, `isReasoningCommand`, and
`isSummarizeCommand` are all **exported and unit-tested**, yet neither dispatch
path calls them — both use raw string equality (`cmd === "exit"`, `cmd === "clear"`,
etc.). The predicates and the runtime behavior can drift independently, and the
test suite gates the predicates, **not the dispatch**. A "fix" to a predicate
would pass tests while changing nothing the user sees.

**Recommendation**: P3 cleanup. Fold into Gap 4's `commands.js` extraction: route
dispatch through the predicates so the tested functions actually gate behavior.
No user-visible change; it makes the existing test coverage meaningful. Do **not**
do this as a standalone churn commit — bundle it with the file split. Estimate:
absorbed into Gap 4's 3-4 hr.

---

## What's Already Done (Verified)

All items listed as complete in the 2026-06-08 audit remain accurate. Quick
re-verification against live source:

- **P0 events**: `tool_budget_exhausted` (:229-236), `generated_file` (:237-243),
  `delete_confirm_pending` (:245-254), `context_trimmed` (:256-261) — all handled.
- **P1 events**: `context_warning` (:263-268), `context_handoff_suggested` (:270-274),
  `skills_matched` (:297-302), `recall_result` (:304-307), `tool_start` (:282-287),
  `tool_result` (:289-295), `ttl_chip` (:309-314) — all handled.
- **Informational**: `context_summarized`, `handoff_written`, `suggestions_saved`,
  `tool_count`, `startup_breakdown`, `session_created/resumed`, `paths_updated` — all handled.
- **Round-table emitter**: `roundtable_phase` (:364-371), `roundtable_agreed` (:373-377),
  `roundtable_no_agreement` (:379-388), `roundtable_error` (:391-397),
  `roundtable_aborted` (:399-403) — all handled with proper formatting.
- **Fallback**: Unknown event types print `[event: type]` (:413-415).
- **Proxy commands**: All listed commands verified present and functional.
- **Standalone commands**: All listed except `discuss` (Gap 1).
- **Token footer**: `[N in · N out · N think · N.Ns]` at `stream_end` (:189-199).
- **Session management & attachment pipeline**: Both paths verified working.

---

## Execution Plan — Next Sprint

### Phase 1: Immediate Fixes (must-do, ~1 hour)

| # | Task | Effort | Priority | Owner |
|---|---|---|---|---|
| 1.1 | Add `isDiscussCommand` dispatch to standalone `promptUser` with clear message: *"Round-table deliberation requires a running Aperio server."* | 15 min | P1 | — |
| 1.2 | Add test for 1.1 — verify `discuss on`/`discuss off`/`discuss` does NOT fall through to chat in standalone | 20 min | P1 | — |
| 1.3 | Add first-`status` print in cliEmitter: `[connected to Aperio vX.Y.Z]` | 15 min | P2 | — |
| 1.4 | Add test for 1.3 — verify status event prints once and only once | 10 min | P2 | — |
| 1.5 | Add `help`/`?` command (Gap 6) + path-aware command listing in both `promptUser` paths | 30 min | P2 | — |
| 1.6 | Add test for 1.5 — verify `help`/`?` does NOT fall through to chat | 10 min | P2 | — |

### Phase 2: Feature Work (should-do, ~4 hours)

| # | Task | Effort | Priority | Owner |
|---|---|---|---|---|
| 2.1 | Evaluate `highlight.js` ANSI integration — spike in a branch, measure bundle size impact and render quality on real code blocks | 1 hr | P3 | — |
| 2.2 | If spike passes: integrate `highlight.js` with capped language set into `renderMarkdown()`, add tests | 2 hr | P3 | — |
| 2.3 | Voice/TTS: add a one-line note to terminal help/reference that TTS is Web UI-only. Close the gap in `terminal-feat.md`. | 15 min | P3 | — |
| 2.4 | If terminal.js crosses 1250 lines in Phase 1: extract `lib/terminal/commands.js` (predicates + dispatch) | 1 hr | P3 | — |

### Phase 3: Deferred / Watchlist

| # | Task | Trigger | Priority |
|---|---|---|---|
| 3.1 | Full file split (`commands.js`, `attach.js`, `session-picker.js`) | terminal.js reaches ~1500 lines | P4 |
| 3.2 | Local TTS via `say`/`espeak` | User request or accessibility audit | P4 |
| 3.3 | Full standalone round-table support | `runRoundTable()` decoupled from WebSocket | P5 (unlikely) |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `highlight.js` adds >200 KB to install size | Medium | Low | Cap languages, make optional |
| File split introduces regression in command dispatch | Low | High | Extract after Phase 1 tests land; use existing test suite as gate |
| Standalone users expect round-table parity with proxy | Medium | Low | Clear message in Phase 1.1 sets expectations |

---

## Notes for the Implementer

1. **Gap 1.1 implementation**: The standalone `promptUser` dispatch (line 994) currently uses a flat chain of `if` statements. Insert the discuss handler **before** the attach handler (line 1093) to mirror the proxy dispatch order. Use the same `isDiscussCommand(cmd)` predicate already imported at line 340.

2. **Gap 1.3 implementation**: Track a `_statusPrinted` boolean in cliEmitter's closure. Print on first `status` event only. Use `const { version } = require(resolve(ROOT, "package.json"))` from the terminal entry point (already available at line 85) to populate the version string. The version will need to be threaded through `makeCliEmitter` options or read via a require inside the emitter closure.

3. **Testing note**: `tests/lib/terminal.test.js` imports from `lib/terminal.js`. New tests for the discuss handler should verify that `isDiscussCommand` returns true for `"discuss on"`, `"discuss off"`, `"discuss"`, and false for `"discussion about AI"` and `"let's discuss"`.

4. **Context for next audit**: The `discuss` gap is the only broken UX. All other gaps are polish. If Phase 1 ships, the terminal is feature-complete from a UX perspective — everything the user can do in proxy mode will either work or surface a clear limitation message in standalone.


# Help & First-Run Audit — follow-up to #175

Companion to the Terminal Audit (#175). That issue measured the terminal against
its *own* feature set. This note looks at it through one extra lens: **what does
the terminal feel like to a non-coder who opened it out of curiosity?** Several
of #175's gaps (5 — no "ready" confirmation; 6 — no `help`) live here too, so
this doubles as the close-out for the onboarding slice.

Audited against the current `lib/terminal.js`, `lib/emitters/cliEmitter.js`, and
`lib/utils/chat-utils.js`.

---

## Shipped in this pass

A first-run experience aimed at "pleasant exercise," not "scary terminal."

- **Speaker label `A:` → `Aperio`.** `A:` reads as a cryptic robot to a newcomer;
  the product name introduces itself. (Round-table `α`/`β` labels unchanged — that's
  an advanced mode.)
- **Token footer is off by default**, toggled with `stats`. `[2,074 in · 16 out · 0.5s]`
  reads like a meter running / something costing money to a normal person. The data
  still flows; power users type `stats` to bring it back.
- **Calm header line 1** — `✦ Aperio · <model> · ready`, where the right segment is a
  *live state*: `ready` when idle, the work label (`thinking…`) while generating.
  This is the always-visible "I'm up and listening" signal → **closes #175 Gap 5.**
- **Navbar restored (line 4)** — `standalone · Docker on · sqlite`, dim. Cut briefly
  as "jargon," but it reassures rather than scares; kept dim so it doesn't compete
  with the friendly line above.
- **`status`** — labeled, on-demand readout of mode / model / docker / storage.
  (Overlaps the navbar; see "Converge status + navbar" below.)
- **`help` / `?`** — plain-language, path-aware command guide → **closes #175 Gap 6.**
- **Welcome banner** on startup (both proxy and standalone) — value line + three
  Aperio-domain examples + "type help."

All changes are surgical (no refactor of the ~1.3k-line file). Verified:
`tests/lib/terminal.test.js`, `tests/lib/utils/chat-utils.test.js`,
`tests/lib/agent.test.js` — all pass; new predicate tests added for
`isHelpCommand` / `isStatsCommand` / `isStatusCommand`; header tests updated to the
new design.

---


---

## Still open from #175 (unchanged by this pass)

- **Gap 1** — standalone `discuss` falls through to chat; needs a "round-table needs
  the server (`npm start`)" handler.
- **Gap 2** — syntax highlighting (P3; weigh `highlight.js` bundle cost).
- **Gap 3** — document TTS as Web-UI-only.
- **Gap 4** — file split, deferred until ~1500 lines (currently ~1330).
- **Gap 7** — predicate/dispatch divergence; the new commands route through their
  exported predicates, so they don't add to it.

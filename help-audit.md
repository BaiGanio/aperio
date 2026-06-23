# Terminal Help & First-Run — Living Tracker

> Working doc for the terminal-polish slice. Originated from the #175 terminal
> audit + its onboarding follow-up. **Done items have been pruned** — only open
> work lives below. We iterate on this doc each pass.
>
> Last pruned: **2026-06-23**. `lib/terminal.js` ≈ 1330 lines.

---

## Done (closed — kept only as a one-line ledger)

- **#175 Gap 5** — no "connected/ready" signal → closed by the live header state
  (`✦ Aperio · <model> · ready`, flips to the work label while generating).
- **#175 Gap 6** — no `help` command / zero command discovery → closed by
  path-aware `help` / `?`, plus a startup welcome banner (both proxy & standalone).
- First-run niceties shipped alongside: speaker label `A:` → `Aperio`; token
  footer **off by default**, restored with `stats`; on-demand `status` readout
  (mode / model / docker / storage); restored dim navbar (line 4).
- **#175 Gap 1** — standalone `discuss` falling through to chat → **closed.** The
  dispatch handler shipped in `78c48fb` (audit was stale); this pass corrected the
  gate message to canonical commands (`npm run start:local` / `npm run chat:local`,
  per README Steps 4/5 — there is no `aperio` binary) and added the missing
  `isDiscussCommand` predicate tests.
- **#175 Gap 3** — voice/TTS in the terminal → **closed as won't-build.** Documented
  in `FEATURES.md` Interfaces: Web UI carries voice input + TTS; terminal marked
  text-only (voice/TTS is Web UI only). Local `say`/`espeak` deferred to a future
  accessibility pass.
- **#175 Gap 2** — code syntax highlighting → **closed (shipped).** Integrated
  `emphasize` (^7.0.0) into `renderMarkdown()` with a capped grammar set
  (js/python/bash/json/xml-html/css/sql + hljs aliases); unknown/no-language
  fences fall back to the original flat cyan. Gutter + borders preserved, line
  count intact. New tests in `tests/lib/emitters/cliEmitter.test.js` (5);
  full suite 2141 pass. Decision rationale: render quality good + palette-matched,
  and the +9 MB is 0.9% on a 981 MB install (server-side app, not a bundle).
- Tests: new predicate tests for `isHelpCommand` / `isStatsCommand` /
  `isStatusCommand` / `isDiscussCommand`; header tests updated.
  `terminal.test.js` (78 pass), `chat-utils.test.js`, `agent.test.js` all pass.

---

## Open Gaps

### 4. File split — partially done

**Predicate extraction shipped (2026-06-23).** The ~30 pure `is*Command` predicates
and small utilities now live in `lib/terminal/commands.js`; `lib/terminal.js`
imports them for dispatch and re-exports them so existing import paths (incl.
`tests/lib/terminal.test.js`) are unchanged. `terminal.js`: **1341 → 1146 lines**.
Full suite green (2174). Zero behavior change — gated by the existing predicate
suite.

**Still deferred (the risky half):**
- Decouple the two `promptUser()` dispatch closures (lines ~712, ~1107) from their
  closure state into a shared dispatcher — this is the "dispatch regression:
  Low/High" item, kept out of scope deliberately.
- Extract `attach.js` (`readAttachment`) and `session-picker.js` (list + resume
  flow) — lower-risk but not urgent.
- **Gap 7** (below) rides along with the dispatch decoupling.

### 7. Predicate/dispatch divergence  (P3 — fold into Gap 4's dispatch step)

Several exported, unit-tested predicates (`isExitCommand`, `isClearCommand`,
`isMemoriesCommand`, `isReasoningCommand`, `isSummarizeCommand`, `isSpecialCommand`)
are **not** used by either dispatch path — dispatch uses raw string equality, so a
predicate can drift from runtime behavior while still passing its tests. The
*newly added* commands (help/stats/status) do route through their predicates, so
they don't add to the debt. Now that the predicates live in `commands.js`, the
**cleanup = route dispatch through them** as part of the deferred dispatch-closure
decoupling (above), not a standalone churn commit.

---

## Next-pass plan

No active P1–P3 work remains — every user-visible gap is closed. Only
trigger-gated items are left.

**Deferred:** Gap 4 remainder — dispatch-closure decoupling (carries Gap 7),
plus `attach.js` / `session-picker.js` extraction; local TTS via `say`/`espeak`
(on request / accessibility audit); full standalone round-table (only if
`runRoundTable` is decoupled from WebSocket — unlikely).

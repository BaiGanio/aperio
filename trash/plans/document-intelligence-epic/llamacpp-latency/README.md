# Gemma capability harness

Use this fallback only after the hard end-to-end gate fails. The hard gate is
`../document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs`; it
exercises Aperio's real agent loop, tools, document corpus, confirmation flow,
and wall-clock UX ceiling. A failure there can be workflow latency rather than
a model's basic capability failure.

`gemma-simple-capability-harness.mjs` asks four deterministic short questions:
integer arithmetic, percentage change, average, and a logic implication. It
starts an isolated llama-server, calculates the selected model's full served
context through Aperio's own sizing function, uses llama-server's normal
unbounded completion behavior, applies Aperio's 300-second local-request
deadline, then tears down its process group and scratch directory.

Run the hard gate first. If it fails, run:

```bash
LLAMACPP_MODEL=unsloth/gemma-4-26B-A4B-it-qat-GGUF:Q4_K_XL \
  node trash/plans/document-intelligence-epic/llamacpp-latency/gemma-simple-capability-harness.mjs
```

## 2026-08-04 results

| Model | Full served / usable context | Result |
|---|---:|---|
| Gemma 4 E4B | 113,664 / 104,570 | 3/4: percentage, average, and logic correct; `17 × 23 + 19` incorrectly answered `400`. |
| Gemma 4 26B A4B | 131,072 / 120,586 | 4/4 correct: 4.5–8.9 seconds per response; roughly 200–413 generated reasoning/answer tokens at ~48–50 tok/s. |

This is a capability classification aid, not a substitute for the hard gate.

## 26B hard-gate follow-up

The full isolated document-intelligence provenance harness was then run against
the same 26B model at its Aperio-calculated 131,072-token served window
(120,586 usable), with the agreed 600-second total / 90-second per-turn UX
gate. It indexed the fresh corpus, ran `doc_batch`, and attached 40 schemas,
but its first actual model request was still pre-filling 16,674 fresh tokens at
79.0 seconds and yielded no answer or tool call before the 90-second deadline.
The client timeout did not cancel llama-server's active task, so the identified
scratch-only processes were terminated and their scratch directory removed.

Conclusion: the 26B model is capable on the simple gate, but it does **not**
meet the hard document-intelligence UX gate at the full-context configuration.

## What's left (as of the 2026-08-13 T-L4.2 run)

The original latency plan (`llamacpp-multiturn-latency.md`, deleted in
`c7f64007` with Step 4 outstanding) proposed a wall-clock gate and a repeat
run. Step 4 happened 2026-08-13; here's where it actually landed.

**Ceilings used, and why:** `APERIO_HARNESS_WALLCLOCK_PERTURN_MS=550000`,
`APERIO_HARNESS_WALLCLOCK_TOTAL_MS=2400000`, chosen from T-L4.1's own hardware
numbers (max observed turn 461,830ms, observed total 1,920,086ms) with ~19%
and ~25% headroom respectively — see the run entry in
`../document-intelligence-ws2-tg23-open-issues.md` for the full reasoning.
These are hardware-specific; re-derive them, don't reuse the numbers blindly,
if this ever runs on different hardware.

**Two problems, not one.** The 2026-08-13 run confirms the sticky tool-pin
fix (`6331e7a8`) does not fully solve cache reuse:
- The attached-schema count is **not** flat across a real conversation despite
  the fix — it swung 15→40→40→20→35→35→35→20 across 7 scripted turns, as
  `classifyProfiles()` keeps re-picking profiles from each turn's own message
  content. The fix pins *within* a turn's tool-selection call but nothing
  currently pins the profile set *across* turns for a live conversation.
- More surprising: even in the one place the schema set **did** stay
  identical (40/74 schemas, two consecutive internal model calls), llama-server
  still reported `cache_n=0` — zero prefix reuse. Schema stability is
  necessary but evidently not sufficient here. Not root-caused; the next
  session chasing latency should instrument this specific case (a real
  conversation, not the synthetic `llamacpp-cache-probe.mjs` sequence) to see
  what else differs turn to turn — system-prompt content, tool-result
  ordering, and timestamp-bearing context are the first things to rule out.

**The save/insert-mechanics gap is now confirmed separate from latency.** The
2026-08-13 run's real failure — the model proposes a save plan in prose and
asks for chat-style confirmation instead of emitting the propose-write tool
call, then only ever issues `CREATE TABLE` and never `INSERT` even when told
explicitly a third time — happened on turns that completed well within
budget (304-378s, under the 550s per-turn ceiling). This is not a latency
symptom; it needs its own SKILL.md/prompting investigation, independent of
whatever happens with the cache-reuse gap above.

**Grader bug found the same run**, opposite direction from the three fixed
2026-08-02 false-passes: the `noFxBlend`/`fullMonthGate` check false-flagged
an honest, correctly-disclosed non-blended answer as a violation. Not fixed
this session — see the run entry for detail.

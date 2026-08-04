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

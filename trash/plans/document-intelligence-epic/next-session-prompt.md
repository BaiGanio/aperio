# Next session — WS2 hero-model gate (#250)

Written 2026-08-13. Paste the prompt below into a fresh session. Delete this file once the
gate is green and WS4 starts.

---

## The prompt

> Close out the last open gate of the document-intelligence epic (#250): **WS2 T-G2.3 (SQL
> provenance) and T-G2.4 (no currency blending) on the local hero model, Gemma 4 E4B.**
> Everything this gate was blocked on has shipped and nobody has re-run it since.
>
> Read first, in this order: `trash/plans/document-intelligence-epic/document-intelligence-epic-summary.md`
> (compact handoff — harness invocations and prompts are in it), then
> `document-intelligence-ws2-tg23-open-issues.md` (what failed and why the grader used to
> lie about it), then `llamacpp-latency/README.md`. The canonical plan is
> `document-intelligence-epic.md`; its status header is current as of 2026-08-13.
>
> **Before the run — decide the wall-clock ceiling.** The harness gates on
> `APERIO_HARNESS_WALLCLOCK_TOTAL_MS` / `APERIO_HARNESS_WALLCLOCK_PERTURN_MS`, both
> defaulting to `Infinity` (opt-in) since the last session. The original 600s total / 90s
> per turn was never physically reachable on this machine: T-L4.1 measured ~120–133 tok/s
> prefill against 23–26K genuinely new tokens per turn, so a turn has a hard floor near
> 200s here. Pick a ceiling from those real numbers and say what you based it on. A ceiling
> that guarantees failure tests nothing; a ceiling of `Infinity` tests nothing either.
>
> **The run:**
> ```bash
> DOCINT_PHASE=provenance DOCINT_EVALUATION_PROVIDER=llamacpp \
>   LLAMACPP_MODEL=unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL \
>   APERIO_HARNESS_WALLCLOCK_TOTAL_MS=<chosen> APERIO_HARNESS_WALLCLOCK_PERTURN_MS=<chosen> \
>   node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
> ```
> Run it in the background — expect 10–30 minutes. It creates its own isolated scratch
> workspace, scratch SQLite, and free loopback ports, and tears them down in `finally`. Its
> output artifact `document-intelligence-run-answers.json` is git-ignored as of 2026-08-13,
> so **do not** run `git checkout --` on it afterwards; that ritual is retired.
>
> **Grade it turn by turn, not by `grading.status`.** That field has produced a false pass
> in this exact harness before. Specifically confirm, from the transcript:
> 1. a confirmed `db_execute` **INSERT** with `rowsAffected > 0` — a confirmed `CREATE TABLE`
>    is not a save;
> 2. a `db_query` that actually **returned rows**, and a final answer that narrates *those*
>    numbers rather than reciting extraction results from earlier in the conversation;
> 3. **no** total-cue line anywhere that adds BGN and EUR into one figure — June is
>    696.84 BGN with 196.40 EUR reported separately; the recorded failure was a closing
>    "Overall Grand Total: 893.24";
> 4. per-turn `timings.cache_n` staying stable and the attached-schema count flat from turn 2
>    on — that is the sticky-tool-pin fix (`6331e7a8`) still working, and it is worth
>    recording either way.
>
> `skills/document-intelligence/SKILL.md` was revised on 2026-08-13 to target failure modes
> 1–3 directly, so this run is also the first test of those edits. If the model still fails,
> say which of the four checks failed and whether the skill's new wording was followed and
> insufficient, or simply not followed — those are different problems with different fixes,
> and conflating them is how the last false pass happened.
>
> If it passes: record it in the epic's evidence log, update the status header, and WS4/T-G6
> becomes next (hero-model table + a standalone HTML pie-chart preview — preview and approval
> before any integration, per AGENTS.md). If it fails: record the real reason and stop before
> WS4; do not paper over it with prompt steering.
>
> Do not start the capability-manual work (`trash/plans/docint-capability-manual/`) in this
> session — it wants this gate's result as its freshest ledger record.

---

## Context the prompt assumes

**Why the gate was stuck, and why it isn't any more.** The failure was never the skill's
wording. `planTurnTools()` re-picked a different tool-schema subset every turn, which shifts
the prompt prefix and defeats llama-server's KV-cache reuse across the whole growing
conversation — turns took 350–600s and the flow never reached a real queried total. Fixed by
the sticky tool-pin (`6331e7a8`, `f1377b1e`) plus `doc_batch` dedup (`2dc99e65`). Then a
second, unrelated blocker: a `db_execute` INSERT whose `params` didn't match its placeholders
passed propose-time validation and threw an uncaught `RangeError` at confirm time — the row
never landed while the model kept insisting the save had worked. Fixed in `a23c010f`. With
both fixed, a pass is structurally reachable for the first time.

**Watch for** a malformed pseudo-tool-call (`<execute_tool_call>…</execute_tool_call>` with
`<|"|>` placeholder quote tokens) — seen once from this model. `TOOL_LEAK_PATTERNS` in
`lib/tools/executor.js` does not catch that tag shape. Low-risk known gap; note it if it
recurs, don't chase it mid-gate.

**Do not trust these two things:** `grading.status` alone (three false-pass bugs already
fixed in this harness), and any claim that T-G2.1/2.2/2.4 "pass live on gemma4" — that claim
predates the llama.cpp path existing in this harness and was never validated through it.

**Housekeeping still open** (in `A2D.md`): the llama.cpp latency plan file was deleted in
`c7f64007` while Step 4 was outstanding, so the remaining latency spec lives only in git
history — worth reconstructing a short "what's left" section into `llamacpp-latency/README.md`
while the numbers from this run are fresh.

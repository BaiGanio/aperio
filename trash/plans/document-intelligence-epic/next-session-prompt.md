WS2 of the document-intelligence epic (#250) has its **first clean pass**. Ornith-1.0-9B ran
`DOCINT_PHASE=provenance` on 2026-08-14 and returned `status: pass`, `failures: []`, with all
three gates green and the strongest capability claim the harness awards:

```
T-G2.3: PASS   successTurn: 2 · successPromptTier: named-mechanism · capabilityClaim: realistic-usage
T-G2.4: PASS   fullMonthGate ✓  noFxBlend ✓
T-L4:   PASS   386,455 / 84,865 / 48,885 ms — total 520,205 of 2,400,000
```

Your job is to decide what that pass buys, and to close WS2 or say precisely what it still needs.

**Verify before building on this.** Read the code and the archived transcripts, not this summary.
This epic has a history of confident handoffs that were false — a previous version of this file
sent a session to run a measurement that had already been cancelled and to try an experiment that
had already been retired. Everything below is checkable: `var/docint-runs/` holds the archived
transcripts, and `replay-grading.mjs <artifact>` re-grades any of them without booting anything.

## Read first

1. The two 2026-08-14 sections at the top of `document-intelligence-ws2-tg23-open-issues.md`.
2. `id/reference/tech-debt.md` → "Document-intelligence harness — grader (#250)", especially the
   *pattern* entry: four false failures of the same prose-matching class, all found by runs they
   invalidated.

## What is settled — do not re-open

- **The gate split.** `grading.mjs` tags every check and failure with its owning gate and reports
  `grading.gates`; `status`/`failures` stay byte-identical so replay diffs still work. Rounds 10
  and 11 were never provenance failures (currency blend, arithmetic double-count) — only round
  12's missing INSERT was.
- **The `db_execute` argument defect** (`8e54bf4c`), three parts: required `connection` on the
  propose path with a pointed message; the lookup error reports the trimmed name; and
  `db_execute` out of `DESTRUCTIVE_TOOLS` because it is two-phase confirm-gated and renders
  connection, statement type, SQL and params for review before executing.
- **The category-decomposition false failure**, fixed as `statedAsComponents`. Do not loosen its
  last two constraints — the first attempt lacked them and the suite's mutation tests caught it
  laundering a false headline figure with a correct parenthetical breakdown.
- **The KV-reuse and wall-clock infrastructure** (rounds 9-11).
- **The SKILL.md never-sum-across-currencies lead** — retired by round 12.

## The decision in front of you

**Does one clean run close T-G2.3?** Arguments both ways, stated honestly:

- *For:* the failure was never "the flow is impossible" — it was three separate claims ORed into
  one number plus a tool-argument bug. With those fixed, a 9B local model completed the flow at
  the realistic-usage rung with an exactly correct answer. The structural checks
  (`insertedRealRows`, `dbQueryReturnedRealRows`) carry the evidentiary weight and both held.
- *Against:* n=1 on the fixed code. Ornith's own run 1 passed T-G2.3 only at the weaker
  `dictated-sql` rung, so run-to-run variance on the rung is real and observed. And the gate is
  nominally about the **local hero model**, which is currently gemma-4-E4B, not Ornith.

Three concrete options, in the order I'd weigh them:

1. **Close T-G2.3 for Ornith, and re-point the hero model.** Honest and specific: the gate passes
   on a named model, and `LLAMACPP_MODEL` moves to Ornith for document work. Requires deciding
   Ornith is the hero model, which is a bigger call than this gate.
2. **Ask for 2-3 consecutive passes before closing.** ~10 min per run now that total wall time is
   520 s. Cheap, and it measures the rung variance that run 1 vs run 2 already exposed.
3. **Run gemma-4-12B and gemma-4-26B-A4B against the fixed code first.** Neither has a valid
   result: the 12B run was stopped at turn 3 against pre-fix code, and the 26B run was stopped
   during turn 0. If either passes, the gate is a property of the harness fix rather than of one
   model, which is a much stronger claim.

The command (drop `LLAMACPP_MODEL` to whichever model):

```
DOCINT_PHASE=provenance DOCINT_EVALUATION_PROVIDER=llamacpp \
  LLAMACPP_MODEL=protoLabsAI/Ornith-1.0-9B-MTP-GGUF:Q4_K_M \
  APERIO_HARNESS_TIMEOUT_MS=1800000 \
  APERIO_HARNESS_WALLCLOCK_TOTAL_MS=2400000 APERIO_HARNESS_WALLCLOCK_PERTURN_MS=550000 \
  APERIO_LOG_CACHE_FINGERPRINT=on \
  node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
```

Cached and offline-resolvable: `protoLabsAI/Ornith-1.0-9B-MTP-GGUF:Q4_K_M`,
`unsloth/gemma-4-12B-it-qat-GGUF:Q4_K_XL`, `unsloth/gemma-4-26B-A4B-it-qat-GGUF:Q4_K_XL`,
`unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL`. The harness is self-isolating (own port, scratch DB,
own llama-server, teardown in `finally`) — but if you kill it, that `finally` is skipped: check
`pgrep -f llama-server` and remove the `/var/folders/**/aperio-document-intelligence-skill-*`
directory belonging to your run, and nothing else.

## Known-open, none of them blockers

- **The prose-predicate class is at four false failures.** Before pointing this gate at another
  model, consider moving category grading off substring matching entirely rather than patching a
  fifth time.
- **Ornith claimed rows it never wrote.** Run 2's answer says "10 rows inserted" and that the EUR
  receipts "are saved separately" — one INSERT of 10 BGN rows actually happened; the EUR receipts
  were described, never stored. Ungraded by any check, and a candidate for a new one.
- **Run 1 wrote a wrong figure to memory** (796.84, off by exactly 100.00) via an unprompted
  `remember` while its graded SQL answer was exact. Ungraded, and it would outlive the session.
- **`db_schema` on the reserved `extraction` name** replies "no connection named extraction"
  without mentioning that it self-provisions on the first confirmed write. Accurate but
  incomplete; every model so far recovered.
- **`checkArgs` still cannot report `connection`/`sql` as `missing_required` for `db_execute`**
  (they are `.optional()` for the confirm re-invoke), so `var/toolrepair/events.tsv` under-counts
  propose-path argument quality. Needs a per-tool "required when proposing" overlay; not needed
  for correctness now that the handler speaks.
- **An aborted run leaves a zero-turn artifact** that becomes "newest", so a bare
  `replay-grading.mjs` picks it and errors. Pass the path explicitly, or `--list`.
- **Per-token prefill cost climbs with context depth** (7.71 → 20.4 ms/token). Never investigated.
- **The `maxHistory` hysteresis cut has never been observed firing.**

## State of the worktree

All of the above is committed on `master`. Full scoped run at commit time: **2666 unit + 32
harness + 52 database-confirm + 30 harness-gate + 18 grading, 0 failures.**

Check `git status` before assuming anything else in the tree is yours — this repository is
routinely worked by concurrent sessions.

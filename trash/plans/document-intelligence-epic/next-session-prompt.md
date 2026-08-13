# Next session — WS2 hero-model gate re-validation (#250), round 3

Written 2026-08-13 (evening session, following the afternoon SKILL.md fixes and a same-day
re-run that failed differently and was stopped early). Paste the prompt below into a fresh
session. Delete this file once the gate is green (or once you've decided the remaining
failure needs a structural fix, not more wording) and WS4 starts.

---

## The prompt

> Validate this evening's fixes against the last open gate of the document-intelligence
> epic (#250): **WS2 T-G2.3 (SQL provenance) and T-G2.4 (no currency blending / no
> excluded-document leak) on the local hero model, gemma4-E4B.**
>
> Read first, in this order: `trash/plans/document-intelligence-epic/document-intelligence-epic-summary.md`,
> then `document-intelligence-ws2-tg23-open-issues.md`, then `id/reference/tech-debt.md`'s
> "Document Intelligence — save/insert mechanics on gemma4" section (the newest, dated
> 2026-08-13-evening entry carries this session's findings) and its "Tool profiles / schema
> budgeting" section. `skills/document-intelligence/SKILL.md` and `lib/agent/tool-profiles.js`
> were both edited this session — read both in full before running anything.
>
> **What happened this evening, and why the gate is still open:**
> A live re-run (same harness, same command as every prior T-L4 attempt) got three
> consecutive turn failures and was stopped by the developer before completion:
> - **Turn 0** (main prompt, explicit "save the results so I can query them again later"):
>   called **zero** `db_execute` — not even a `CREATE TABLE`. Worse than every prior
>   mechanism-ladder run, which always attempted at least table creation on turn 0.
> - **Turn 1** (follow-up 1, "query it per category"): issued a `db_query` against a table
>   name it invented on the spot, **before ever calling `db_schema`** — the query's own
>   error ("no connection named extraction") was the only signal nothing existed yet. It
>   then created the table. Still no `INSERT`.
> - **Turn 2** (follow-up 2, explicit "a single multi-row INSERT is fine" — the exact turn
>   today's earlier worked-example fix targets): produced **zero tool calls**, only ~52s of
>   prose. The next turn reverted to re-reading a source document instead of inserting.
>
> The developer's standing rule for this session, worth carrying forward: **if any turn
> fails, say so immediately and ask before continuing** — don't wait for the run to finish
> to report a bad turn. Three failures in a row is what triggered the stop-and-fix below;
> don't let a fourth run past a turn like turn 2 without flagging it live.
>
> **Two fixes landed this evening in response, one skill-level and one code-level — treat
> them differently when judging this run:**
>
> 1. **SKILL.md, two new §5 bullets** (prose fix, unvalidated): (a) verify `db_schema`/a
>    prior confirmed `CREATE TABLE` before the *first* `db_query`/write in a conversation,
>    not just before a second save attempt (the existing bullet only covered the second
>    case); (b) an explicit "describing a save is not doing it — the turn must contain the
>    `db_execute` call itself" rule, targeting turn 2's zero-tool-call pattern directly.
>    Bullet (b) in particular is a guess at a cause the transcript couldn't fully confirm —
>    the harness only writes answer text to disk on a clean exit, which the developer's
>    SIGTERM (used to stop the run) skipped, so turn 2's actual prose was never captured.
>    If turn 2 (or its equivalent) fails the same way again, that's real evidence the
>    wording didn't address the actual cause, not proof the fix is wrong — the cause was
>    never confirmed to begin with.
> 2. **`lib/agent/tool-profiles.js`, `classifyProfiles`, a real code fix** (root-caused,
>    not a guess): the `shell` tool profile's bare `\brun\b` keyword matched ordinary SQL
>    phrasing ("run SELECT category, currency, SUM(amount) GROUP BY..."), spuriously
>    attaching `run_shell`'s schema on a plain database follow-up. This is the previously
>    "unexplained shell tool-profile addition" flagged as a mystery in T-L4.2 and this
>    morning's 26B-A4B run — now explained. `classifyProfiles` already had a narrowing
>    guard against exactly this false-positive class for docGraph intent; the fix extends
>    the same guard to database intent. 3 new regression tests
>    (`tests/unit/agent/tool-profiles.test.js`) plus the full 2627-test unit suite are
>    green. This is a real, evidenced contributor to the broader tool-schema-instability /
>    llama.cpp cache-reuse gap tracked in tech-debt.md's "Tool profiles / schema
>    budgeting" section — **but almost certainly not the only cause**: the 38↔40
>    fingerprint swing at every run's turn-0→1 boundary predates this specific trigger and
>    still needs its own explanation. Don't credit this fix with fixing the whole
>    cache-reuse gap; it closes one confirmed contributing mechanism.
>
> **Three items stay open from earlier sessions and are unaffected by tonight's fixes:**
> - The turn-0→1 fingerprint swing (38→40) itself — every run this epic has shown it, this
>   fix doesn't touch it.
> - gemma-4-26B-A4B's turn-1 total non-engagement (600s timeout, zero tool calls, zero
>   tokens) from this morning's run — one data point, unexplained, not gating gemma4-E4B.
> - The currency-blend/travel-exclusion SKILL.md §6 wording from this morning (already a
>   *second* attempt on Ornith's two real failures) — still unvalidated live. If you get far
>   enough into a run to reach that check and it fails again, that's the design-question
>   escalation the earlier prompt already flagged, not a new problem.
>
> **The run:**
> ```bash
> DOCINT_PHASE=provenance DOCINT_EVALUATION_PROVIDER=llamacpp \
>   LLAMACPP_MODEL=unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL \
>   APERIO_HARNESS_WALLCLOCK_TOTAL_MS=2400000 APERIO_HARNESS_WALLCLOCK_PERTURN_MS=550000 \
>   APERIO_LOG_CACHE_FINGERPRINT=on \
>   node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
> ```
> Run in the background, but **check in turn by turn as events land — don't wait for
> completion to report** (tail the harness's own `HARNESS tool_start`/`HARNESS
> tool_result`/`HARNESS turn wallMs` log lines; a `Monitor` on those markers works well).
> If turn 0, 1, or 2 repeats last time's exact failure shape (no `db_execute` at all;
> `db_query` before `db_schema`; a zero-tool-call turn after explicit INSERT permission),
> say so immediately and ask whether to stop and iterate again, rather than letting the
> whole ladder play out on a run that's already failed.
>
> **If gemma4-E4B gets further than last time** (an actual `INSERT` attempted, ideally
> landing) — grade turn by turn against the same 5 checks the previous prompt specified:
> single multi-row `INSERT` with matching `rowsAffected`; correct verify-before-second-save
> behavior if a second save is reached; no BGN/EUR blend anywhere in the final answer; no
> excluded travel document reported without disclosure; query columns matching the model's
> own schema. State explicitly, per check, whether it passed, and if not, whether the
> SKILL.md wording was **followed and insufficient** or **not followed at all**.
>
> **Only after gemma4-E4B either passes clean or fails in a way that's a genuine, specific,
> new signal** (not a repeat of tonight's three-turn collapse), move to Ornith-1.0-9B with
> the same command (`LLAMACPP_MODEL=protoLabsAI/Ornith-1.0-9B-MTP-GGUF:Q4_K_M`) to
> re-validate the currency-blend/travel-exclusion fixes against its two real prior
> failures. Both runs create their own isolated scratch workspace/DB and clean up in
> `finally` on a normal exit — **if you have to stop a run mid-flight, SIGTERM leaves the
> llama-server child and scratch temp dir orphaned** (confirmed this session: no signal
> handler exists in the harness to run its cleanup on SIGTERM). Check `ps aux` for
> `llama-server`/`document-intelligence-skill-harness` and remove the scratch dir under
> `$TMPDIR/aperio-document-intelligence-skill-*` by hand if you do.
>
> If gemma4-E4B fails the same specific way a third time (zero tool calls on the explicit
> multi-row-INSERT turn, or db_query-before-schema), that is real evidence prose alone has
> hit a ceiling on this failure mode too — stop and bring it back as a design question
> (e.g., forcing the propose/confirm flow through a different tool-call shape, or
> investigating whether this is actually a generation/parsing issue rather than a
> knowledge gap) rather than writing a third wording iteration blind.
>
> Do not start the capability-manual work (`trash/plans/docint-capability-manual/`) in this
> session — it wants this gate's result as its freshest ledger record.

---

## Context the prompt assumes

**Why this is round 3.** Morning: cross-model T-L4 run found gemma4-E4B's VALUES/params
mismatch bug plus Ornith's currency-blend/travel-leak bugs; SKILL.md fixes written for both.
Afternoon (this file's previous version): a re-run to validate those fixes was itself stopped
early after three consecutive turn failures that never even reached the VALUES/params bug —
the model didn't attempt an `INSERT` at all this run. That triggered two fixes: a SKILL.md
prose addition (unvalidated, targets a cause that couldn't be fully confirmed since the
transcript was lost to the stop) and a real code fix (root-caused and tested) for a spurious
`shell` tool-profile trigger on ordinary SQL language. Neither fix has been run live yet —
that's this prompt's whole job.

**The lesson worth carrying forward operationally**: report bad turns as they happen, not at
the end of a run. That's what made this round's diagnosis possible at all — the developer
caught the pattern (3 failures, not just 1) and asked for a stop before the run burned another
20+ minutes on a ladder that had already failed its actual goal.

**The one thing worth taking seriously going in:** the SKILL.md "narrating isn't doing it"
bullet is a good-faith guess, not a confirmed fix — the actual answer text that would prove or
disprove it was never captured. If it fails identically again, don't write a fourth SKILL.md
iteration on the same guess; treat it as evidence the real cause is something else (possibly
generation-level, not prompt-level) and say so plainly, per AGENTS.md — "the elenchus runs
both ways."

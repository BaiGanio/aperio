# Next session — WS2 hero-model gate re-validation (#250), round 4 (design question, not another wording pass)

Written 2026-08-13 (evening session). Paste the prompt below into a fresh session. Delete this
file once the gate is green, or once WS4 starts on a deliberate decision to proceed without it.

---

## The prompt

> Pick up the last open gate of the document-intelligence epic (#250): **WS2 T-G2.3 (SQL
> provenance) on the local hero model, gemma4-E4B.** This is round 4. Rounds 1-3 all failed the
> same specific way on the turn that hands the model explicit permission to write ("a single
> multi-row INSERT is fine"): **zero tool calls**, prose only, followed by the next turn
> reverting to re-reading a source document instead of inserting.
>
> **Do not write a fourth SKILL.md wording iteration on this specific failure before reading
> this history first**, in order: `trash/plans/document-intelligence-epic/document-intelligence-epic-summary.md`,
> then `document-intelligence-ws2-tg23-open-issues.md`, then `id/reference/tech-debt.md`'s
> "Document Intelligence — save/insert mechanics on gemma4" section — read every entry, not just
> the newest, since the newest one is the point of this prompt: **round 3, run the same evening
> the "describing a save is not doing it" bullet landed, hit the exact failure that bullet was
> written to fix, on the very first live test of it.** A wording fix that fails its first test
> immediately, on the exact scenario it targets, is different evidence than a fix that's simply
> "unvalidated" — it's a real signal that prose repetition of a rule the model already isn't
> following is unlikely to work on a fifth attempt either.
>
> **What round 3 actually showed (full detail in tech-debt.md):**
> - Turn 0: `doc_batch` → `db_connections` (checked existing state — working as intended) →
>   `CREATE TABLE`, confirmed, no INSERT. Ordinary mechanism-ladder shape.
> - Turn 1: real `db_query` against its own correct table/column names, correctly returned
>   near-empty (table still has no rows) — the known "correct query, empty table" pattern, not a
>   bug.
> - Turn 2 (explicit multi-row-INSERT permission): **zero tool calls**, 71,956ms of real
>   generation (44,270 input / 993 output / 610 thinking tokens — not a stall), pure prose. Turn
>   3 immediately reverted to `doc_batch` instead of inserting.
> - Killed at this point per the developer's own standing rule (kill on the first turn that
>   repeats a known failure shape, don't let the ladder run out). The `classifyProfiles`
>   shell-narrowing code fix (`e3aad9bf`, real and tested, unrelated to this specific failure)
>   was never exercised this run since no turn 2→3 tool-schema transition happened — it stays a
>   real, evidenced fix for its own narrower bug (spurious `shell` profile on SQL-flavored text),
>   just not a fix for *this* failure.
>
> **The actual open question, worth spending time on before touching SKILL.md again**: is
> gemma4-E4B's zero-tool-call response on this specific turn shape a *prompt-adherence* gap (the
> model understands the instruction but doesn't act on it — the thing prose can fix) or a
> *generation-level* gap (something about this turn's context/history/token position makes the
> model unlikely to emit a tool-call token at all, regardless of what the system prompt says —
> the thing prose cannot fix)? Ideas worth investigating, not yet tried:
> - Inspect the raw completion for this turn (if a run can be captured to completion rather than
>   killed — the harness only writes `document-intelligence-run-answers.json` on a clean exit,
>   never on SIGTERM, so this needs a full run through to see the actual generated text, not just
>   the tool-call trace). Does it contain a near-miss tool-call-shaped fragment, or is it pure
>   natural-language hedging?
> - Compare token-level behavior against a turn of the same rough shape (explicit permission +
>   prior write context) where the model DID call a tool — Ornith-1.0-9B's turn 1 in the earlier
>   cross-model run is the closest positive example available.
> - Consider whether forcing a tool-call-shaped response is achievable at the harness/skill level
>   (e.g., a stricter propose/confirm contract, a different phrasing that makes not-calling-a-tool
>   structurally awkward) rather than relying on the model reading and acting on a rule stated in
>   prose.
>
> **If you do decide the next move is still a SKILL.md/prompt change**, say explicitly why this
> attempt differs from the three that already failed the same way, rather than restating the
> existing bullet more forcefully — per AGENTS.md, "the elenchus runs both ways": if the evidence
> says prose has hit a ceiling, say so plainly rather than iterating on it again.
>
> **Currency-blend/travel-exclusion (§6) re-validation on Ornith-1.0-9B is still separately
> queued and untouched by tonight's rounds** — only pick that up once the save/insert-mechanics
> question above has an actual answer or a deliberate decision to defer it; don't let it become a
> reason to avoid the harder question.
>
> Do not start the capability-manual work (`trash/plans/docint-capability-manual/`) in this
> session — it wants this gate's result as its freshest ledger record.

---

## Context the prompt assumes

**Why round 4 is different from rounds 1-3.** Round 1 (afternoon): three consecutive turn
failures, stopped before the model even attempted an INSERT, motivated two fixes (a SKILL.md
bullet targeting exactly this shape, plus an unrelated `classifyProfiles` code fix). Round 3
(evening, this session): re-ran against both fixes, now committed as `e3aad9bf`; turn 2 failed
identically to round 1's turn 2, on the very first live test of the bullet meant to fix it.
That's a stronger signal than "unvalidated" — it's a fix that didn't survive contact with the
exact scenario it was written for.

**The operational lesson carried across all three rounds tonight**: report bad turns as they
happen, kill on a repeated known failure shape rather than letting a doomed ladder run to
completion, and don't spend a fourth attempt restating the same prose rule without first asking
whether prose is even the right lever for this specific failure.

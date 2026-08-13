# Next session — WS2 T-G2.3 (#250), round 5: verify two landed fixes live

Written 2026-08-13 (afternoon session, superseding the round-4 prompt). Paste the prompt below
into a fresh session. Delete this file once the gate is green, or once WS4 starts on a
deliberate decision to proceed without it.

---

## The prompt

> Pick up the last open gate of the document-intelligence epic (#250): **WS2 T-G2.3 (SQL
> provenance) on the local hero model, gemma4-E4B.** This is round 5, and it is a **verification
> run, not an investigation**: two real code fixes landed last session and neither has been
> exercised live together.
>
> **Read first**, in order: `id/reference/tech-debt.md` — the sections "Skill matching — a
> workflow skill does not survive its own follow-up turns", "Tool profiles / schema budgeting"
> (the 2026-08-13 attribution-corrected entry), "Document Intelligence — harness grader scoping",
> and "Document Intelligence — extraction accuracy". Then
> `trash/plans/document-intelligence-epic/document-intelligence-ws2-tg23-open-issues.md`'s top
> two sections for run history.
>
> **What rounds 1-4 got wrong, so you don't repeat it.** Four rounds of SKILL.md §5 wording were
> written to fix gemma4-E4B's zero-tool-call turn 2. The skill was never in context on that turn:
> `document-intelligence`'s curated keywords are all first-turn discovery phrasing, `scoreSkill`'s
> `qualifies` gate drops a keyword-declaring skill without a literal hit, and matching runs on the
> current message alone — so it attached to turn 0 and to no turn after it, while
> `reasoning-planning` attached to the turn that mattered and told the model to emit a plan as
> prose. **The "prose has hit a ceiling" conclusion is withdrawn: that wording was never tested.**
> Do not write more SKILL.md wording until a run with the skill actually present says it's needed.
>
> **The fixes to verify (all landed, all unit-tested, none verified live):**
> 1. **Skill stickiness** — `computeStickySkills()` in `lib/agent/turn-planner.js` carries the most
>    recent matched skills (max 2, most-recent-first) for `APERIO_SKILL_PIN_TURNS` (default 4)
>    follow-up turns while the flow keeps calling tools. Replaying the real ladder through
>    `planTurnTools` now attaches `document-intelligence` on all five turns.
> 2. **llama.cpp tool-array stability** — `filterPreExecutedTools()` in
>    `lib/agent/tool-profiles.js` now skips the pre-executed-tool omission when the provider is
>    llamacpp. Preflight withholding `doc_manifest`+`doc_batch` was the real cause of the 40→38
>    schema swing (NOT the sticky tool pin — the planner logged `attached=40` on every turn), and
>    it cost a measured `cache_n=12577` of `prompt_n=31067` with **262 s of prefill** on the turn
>    that then blew the 600 s ceiling and failed the gate.
> 3. **Harness grader scoping** — `followUpTurn` now picks the last turn with tool calls or a
>    non-empty answer instead of the literal last turn, which after a timeout is an empty cascade
>    turn. This corrected two false-negative checks on the last run without turning a fail into a
>    pass.
>
> **Run it — no forced skills this time.** `DOCINT_FORCE_SKILLS` was a diagnostic; stickiness
> should now attach the skill on its own, and the run is meaningless as verification if it's set.
> ```
> DOCINT_PHASE=provenance DOCINT_EVALUATION_PROVIDER=llamacpp \
>   LLAMACPP_MODEL=unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL \
>   APERIO_HARNESS_WALLCLOCK_TOTAL_MS=2400000 APERIO_HARNESS_WALLCLOCK_PERTURN_MS=550000 \
>   APERIO_LOG_CACHE_FINGERPRINT=on \
>   node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
> ```
>
> **What to watch, per turn (report at each turn boundary, don't wait for the end):**
> - `[ws] forced skills` must NOT appear. Skill attachment shows up in the skill card / system
>   prompt size instead — `sysHash` staying constant across turns is the signal that the skill is
>   still attached.
> - **`toolCount` must now hold at 40 across a turn that opens with `doc_batch`** (turns 0 and 3
>   last run). A 38 there means fix #2 didn't take.
> - `cache_n` vs `prompt_n` on each `stream_end`, and `prompt_ms`. Last run's failing turn was
>   12,577/31,067 and 262 s. Anything near full reuse means the fix worked.
> - Whether any turn approaches the 600 s hard abort. That abort, not the model, is what has
>   ended the last three runs.
>
> **Standing rules from previous sessions:** report bad turns as they happen; kill on the first
> turn that repeats a known failure shape rather than letting a doomed ladder run out; let a
> cascade of ~4 s empty turns finish rather than killing, since only a clean exit writes
> `document-intelligence-run-answers.json`.
>
> **Two open findings NOT for this session** (they need their own, and folding them in would blur
> the gate result):
> - **Extraction accuracy.** The rows gemma4-E4B actually persisted last run were partly wrong:
>   Groceries 87.45 against the corpus's 140.75, and an `EUR | Trade | 1266250` row that is
>   almost certainly a reference number misparsed as an amount. Both are traceable — the table
>   carries `document_path`. The deeper question is a design fork: the deterministic fact
>   pipeline already reconciles this corpus to 696.84 exactly, so having the model hand-transcribe
>   13 rows may be the wrong architecture regardless of how well it does it.
> - **Malformed tool-call JSON on long arguments.** E4B's first INSERT attempt spilled rows out of
>   `params` into a garbled object key containing `<|"|>` template-escape tokens, swallowing the
>   `sql` field. It self-corrected on retry, unprompted. Model-side; watch for it, don't chase it.
>
> Do not start the capability-manual work (`trash/plans/docint-capability-manual/`) — it wants
> this gate's result as its freshest ledger record.

---

## Context the prompt assumes

**Worktree state at handoff.** Everything from last session is **uncommitted**: `lib/agent/{index,
tool-profiles,turn-planner}.js`, `lib/config.js` (+ regenerated `.env.example` and
`docs/config-reference.md`), `tests/unit/agent/{tool-profiles,turn-planner}.test.js`,
`CHANGELOG.md`, `id/reference/tech-debt.md`, and the harness. Suggested commits, in order:

```
fix(agent): carry a matched skill across its own follow-up turns
fix(agent): keep the llama.cpp tool array stable across preflight turns
fix(docint-harness): grade the last turn with content, not the empty cascade turn
```

Untracked `output/`, `tmp/`, and `trash/plans/manual-visual-system-prototypes/` belong to another
session — leave them alone. Note also that commit `1783938a "chore: ai leftovers"` (another
session) swept up an earlier version of the harness and tech-debt file mid-session.

**Why round 5 is different from rounds 1-4.** Rounds 1-3 iterated SKILL.md wording against a
failure whose cause was a skill-attachment bug, and round 3's bullet failed its first live test
because it was never loaded. Round 4 stopped iterating, found the cause statically (running the
real matcher over the five literal ladder prompts, no model needed), and confirmed it live with a
forced-skill diagnostic: turn 2 produced a real `db_execute` instead of prose, self-corrected a
malformed multi-row INSERT unprompted, and reached `insertedRealRows: true` — the first time
gemma4-E4B has written real rows on this gate — before the 262 s prefill turn hit the ceiling.
Round 5 has nothing left to discover on the mechanism side; it either verifies or it doesn't.

**The most useful artifact when a run is killed** is `var/sessions/<uuid>.json`, not
`document-intelligence-run-answers.json`. The session file survives SIGTERM and holds every raw
assistant completion — that is how round 4 recovered the turn-2 text that identified
`reasoning-planning`'s output template. The answers JSON is only written on a clean exit.

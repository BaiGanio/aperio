# Known Tech Debt

Two kinds of entry live here. **Running Code Depth** (below) is the live log of what we hit
while working and what is still hanging or unfixed — dated, grouped by topic, deleted the
moment it is fixed or promoted to an issue/plan; it mirrors the `A2D.md` convention. The
**curated tables** further down are intentional, long-lived deferrals and
investigated-and-rejected findings — do not "fix" those without discussion.

Code depth only — what we hit, what is still broken. Suggestions, recommendations, and
housekeeping go in `A2D.md`, not here.

## Running Code Depth

> **Convention (mirrors `A2D.md`):** topic-headers with dated lines under them. An entry is
> deleted immediately once it is fixed or promoted to a GitHub issue or a plan — this is a
> live worklist, never a graveyard. The dates are how we tell what is what.

### Format

```markdown
## <Topic / Area>

- <YYYY-MM-DD> <what we hit / what's hanging> — <impact or why it's unfixed>
```

<!-- Add topic sections below as they come up (e.g. ## Codegraph, ## Migrations, ## Providers). -->

## Docgraph — document facts (#250)

- 2026-08-01 `composeMemoryFromDoc()` (`lib/docgraph/retrieval.js:400`) picks a
  memory's period as **service period > invoice date > due date**, the opposite
  of the corpus policy — a June-issued bill for May consumption is promoted as
  "summary — 2026-05". Harmless while `DOCGRAPH_AUTO_MEMORY` is off; must be
  re-pointed at `resolveAssignmentDate()` (`lib/docgraph/facts/contract.js`),
  which now owns period assignment and gets this right, before the bridge is
  ever enabled by default.
- 2026-08-01 **Image-only receipts still contribute nothing.** PNG receipts
  yield `no_text` and are recovered only when a bank-statement row happens to
  cover them. All nine corpus months now reconcile exactly, but that is because
  every image-only receipt in this corpus has a statement row or a `.txt`
  sibling; a household whose receipts are photos only would come up short. The
  deterministic path needs a provider-neutral native-vision seam to close this
  properly: cloud-capable models must remain supported; a vision-capable local
  model (for example Gemma 4) should receive the image directly, while a
  text-only local model (for example Qwen, Ornith, or Phi-4) should route
  through the configured VLM. The extraction result must be structured,
  uncertainty-aware, and never silently treated as deterministic text.

---

## Tool profiles / schema budgeting

- 2026-08-02 `capToolsForWindow` **`break`s** on the first tool that overflows the
  `0.20 × contextWindow` budget rather than skipping it
  (`lib/agent/tool-profiles.js:125-134`), so an over-budget profile is truncated
  mid-set with only a `logger.info` (`lib/agent/index.js:239`). Benign for
  read-only profiles; becomes a correctness problem for any future tool group
  where a partial set is worse than none. Tracked as a decision in #354.
- 2026-08-13 **Root-caused the llamacpp-multiturn-latency cache-reuse gap
  (T-L4, `trash/plans/document-intelligence-epic/llamacpp-latency/`), not yet
  fixed.** A live WS2 T-G2.3 run with a new request-fingerprint hash
  (`APERIO_LOG_CACHE_FINGERPRINT=on`, `lib/agent/providers/llamacpp.js`) plus
  llama-server's own slot-selection log confirmed: the attached tool-schema
  *count* changes turn to turn (38→40→38 across one 7-turn conversation) even
  when `ensureTurn`'s logged `profiles=[...]` label list is byte-identical —
  almost certainly the sticky-pin "carry forward" logic (`f1377b1e`) adding a
  newly-invoked tool (e.g. `db_query`) into the schema set for later turns.
  Because llama.cpp's Jinja tool-calling templates render the tools block near
  the very front of the prompt, any such shift collapses `sim_best` from
  ~0.99 to ~0.2-0.3 (`f_keep` ~0.18-0.2 — an 80%+ KV-cache loss), forcing a
  near-total reprocess of the whole growing conversation (30K+ tokens,
  150-210s at this hardware's throughput) on that turn alone. This is the
  dominant mechanism behind the multi-minute turn latencies chased throughout
  this epic — not a mystery `cache_n=0`, a specific and reproducible cause.
  Needs: either stop `capToolsForProvider`/the carry-forward fold from
  changing the resolved tool SET once a conversation is underway (pin harder
  than today's within-turn pin), or move the tools block to a position in the
  request the template renders after the stable conversation prefix (template-
  dependent, may not be controllable from the request side at all).

---

## Terminal — session summaries

- 2026-08-04 `appendSummary`'s `messageCount: messages.length - 1`
  (`lib/helpers/sessions.js:454`) still hardcodes "drop index 0 as the
  internal greeting", the same wrong assumption `finaliseSession` had until
  today's fix — a fresh (never resumed/branched) session's summary undercounts
  by one real message. Cosmetic only: `messageCount` just feeds the "N
  messages" line in the session-summary UI (`public/scripts/sessions.js`,
  `chat.js`). Not fixed here because `appendSummary`'s 3 call sites
  (`lib/emitters/handlers/ws/summarize.js`, `lib/terminal/standalone.js` ×2)
  would each need the same `firstMessageSynthetic` flag threaded in for a
  display-only off-by-one.

---

## Document Intelligence — cold-start template proposals (#250)

- 2026-08-02 **`inferTemplateProposal()`'s `match_keywords` heuristic is crude
  and unvalidated against real bill diversity.** (`lib/handlers/extraction/extractHandlers.js`)
  When a document matches no known template, the proposed template's
  `match_keywords` come from `matchHandlers.significantWords()` — the top
  8 most-frequent Unicode-letter words (length ≥ 4) anywhere in the document
  text. This is a deliberate, documented deviation from the WS3 plan, which
  never specified a concrete heuristic; the design choice itself (picking
  literal document words over the field's own English role names) is sound
  and language-agnostic, evidenced only by the T-G4.3 synthetic-text tests in
  `tests/integration/handlers/extraction/extractionHandlers.test.js` — never
  against the real household-gen corpus or any real bill. Known weaknesses:
  (1) no distinction between a distinctive issuer name and generic boilerplate
  words ("invoice", "total", "payment") that would appear on every bill from
  every provider, so two DIFFERENT providers' bills could plausibly propose
  near-identical keyword sets and collide in `matchTemplates`' ranking; (2) no
  weighting toward header/title lines, where an issuer name is most likely to
  live, vs. the body; (3) untested on scanned/OCR'd text, which is noisier
  than the clean synthetic snippets used here. Needs real-corpus evidence
  (ideally household-gen bills from several distinct providers) before this
  heuristic can be trusted for genuine cold-start learning rather than just
  passing its own unit tests.

---

## Document Intelligence — save/insert mechanics on gemma4 (#250)

Gemma 4 E4B's own SKILL.md-adherence gaps in the propose→confirm write flow,
found live on the 2026-08-13 T-L4.3 WS2 provenance run (harness-level grading
bugs from the same run are fixed, not listed here — see
`trash/plans/document-intelligence-epic/document-intelligence-ws2-tg23-open-issues.md`).
**SKILL.md wording landed for all three 2026-08-13** (verify-existing-state
bullet + strengthened per-row-INSERT bullet + query-columns-from-own-schema
bullet, `skills/document-intelligence/SKILL.md` §5 and Gotchas). None of the
three is validated yet — that needs a fresh live gemma4 T-L4 run; keep this
entry until that run passes T-G2.3 clean. The three likely interact (fixing
the re-insert hallucination might also fix the per-row-INSERT habit if both
stem from the model not trusting/checking its own prior state).

- 2026-08-13 **Hallucinated re-insertion on a second save attempt.** Told
  (follow-up prompt: "if the rows aren't in the table yet, finish saving them
  now"), the model did not check what was already saved via `db_query` first
  — it inserted 12 new rows with **fabricated placeholder hashes**
  (`"hash1"`…`"hash12"` instead of real `sha256` values), **invented category
  labels never present in the source documents** (`Rent`, `Subscriptions`,
  `Bills/Housing` — the real categories are Utilities/Fuel/Groceries/
  Transport/Internet), **systematically mismatched `amount_normalized` vs
  `original_amount_string` pairs** (e.g. amount `95.6` paired with original
  string `"29.99"` — two different real documents' values shuffled together),
  and **reclassified two of the three explicitly-excluded EUR travel
  receipts as legitimate categorized spending** (the Munich train receipt as
  `Subscriptions`, the Berlin hotel as `Bills/Housing`) — the exact exclusion
  the fixture tests for. This is worse than a wasteful duplicate: it writes
  confabulated financial data into the user's real database as if genuine.
  SKILL.md §5 now tells the model to verify existing state via
  `db_query`/`db_schema` before a second save attempt (landed 2026-08-13,
  unvalidated).
- 2026-08-13 **Per-row INSERT despite explicit multi-row guidance.** The same
  12-row batch above was issued as 12 separate single-row `db_execute`
  confirms, not the one multi-row `INSERT ... VALUES (...), (...), ...`
  SKILL.md §5 already explicitly requires — even though the follow-up prompt
  itself said "a single multi-row INSERT is fine — it's still one statement."
  Confirms this is a live, reproducible gap, not a stale/already-fixed one.
  SKILL.md §5's bullet strengthened 2026-08-13 with the concrete cache-reprocess
  cost of an extra turn (known since the same T-L4.3 run's cache-reuse
  root-cause) as the "why," and an explicit "prompt permission is not license
  to still do it per row" line — unvalidated.
- 2026-08-13 **Wrong column name in the model's own follow-up query.** Turn 4
  ran `SELECT ... SUM(amount) ... FROM spending_june_2026`, but the model's
  own `CREATE TABLE` (confirmed two turns earlier, and re-confirmed via its
  own `db_schema` call in this same turn) named the column
  `amount_normalized`, not `amount`. The failed query then ran into the
  600s per-turn hard timeout with no retry, cascading into two more turns of
  empty answers — the same "broken connection after hard timeout" pattern
  documented from earlier runs. SKILL.md Gotchas now tells the model to
  re-read its own `db_schema` result's exact column names into the query
  rather than retyping from recall (landed 2026-08-13, unvalidated); a
  same-turn retry on a `no such column` error in the harness/agent loop is
  still not attempted.

---

## Db-connect — extraction identity / managed lock

- 2026-08-01 A v1-era extraction row whose connection string is edited BEFORE
  the new build's first touch (no read, write, or provisioning since upgrade)
  stays orphaned: the old raw options are gone and the saved hash cannot be
  inverted, so the row is rejected rather than silently adopting an arbitrary
  `var/extraction/<hash>.db` path (which would reopen the forged-`provisioned`
  hole). Documented in `lib/db-connect/extraction.js` +
  `tests/unit/db-connect/extraction.test.js`; closing it soundly would require
  persisting the adopted identity at first recognition.

---

## Db-connect — placeholder validation (db_execute)

- 2026-08-03 `validateBoundParams()`'s backslash-escaping assumption
  (`lib/db-connect/classify.js`, `maskLiteralsAndComments`) is per-ENGINE,
  not per-CONNECTION: MySQL is assumed to have backslash escapes enabled
  (true unless the connection's session has `NO_BACKSLASH_ESCAPES` set) and
  Postgres is assumed to have them disabled outside `E'...'` strings (true
  unless the connection has the long-deprecated `standard_conforming_strings
  = off`). Both are correct for the overwhelming majority of real
  connections — matching each engine's default — but a connection actually
  running the non-default mode would see the opposite masking behavior:
  correct placeholders inside a `'...'` string containing a backslash could
  be miscounted, rejecting a valid write before it's ever proposed. Aperio
  has no way to know the connection's actual mode without adding a live
  `SHOW VARIABLES LIKE 'sql_mode'` / `SHOW standard_conforming_strings`
  round-trip (and caching) before every `db_execute` validation, which is
  disproportionate machinery for this. Not attempted; would need a per-
  connection setting (set once when the connection is configured) rather
  than a runtime query, if ever addressed.
- 2026-08-04 `splitStatements()` (same file) still applies ONE dialect-neutral
  comment grammar, while `maskLiteralsAndComments()` is now dialect-aware for
  both comment forms. It therefore diverges from MySQL (`--x` with no space is
  not a comment there, and `/*! … */` is executed) and from Postgres/SQL
  Server (block comments nest). A `;` hidden inside such a span makes a real
  multi-statement batch classify as a single statement. Not a routing hole in
  practice: the classifier's job there is only to pick db_query vs db_execute,
  and every driver is opened with multi-statement execution disabled (mysql2's
  `multipleStatements` defaults to false), so the extra statement fails at the
  driver rather than running. Fixing it would mean plumbing `engine` through
  `splitStatements()` and every `classify()` caller; deliberately not done for
  a case with no reachable consequence.

---

## Intentional deferrals

These are intentional deferrals. Do not "fix" them without discussion.

| Item | Status | Blocked on |
|------|--------|------------|
| CSP headers disabled | Resolved: Helmet CSP is enforced by default; use `APERIO_CSP=report` for rollout diagnostics | — |
| `tree-sitter` pinned at `^0.24.7` | Cannot upgrade to 0.25+ (ABI 15) | `tree-sitter-wasms` must ship ABI-15 grammar builds |

## Investigated and rejected

Not deferrals — these were built, measured, and found not to work. Do not re-attempt the same
approach without new evidence; a different mechanism may still be worth trying.

| Item | Finding | Evidence |
|------|---------|----------|
| Memory compaction via deterministic filler-phrase rewriting (issue #286, `/caveman-compress` borrow) | Real Aperio memory content contains no removable conversational filler — 0.00% token savings measured against both the capability-exam corpus and every real row in the dev DB. Content is terse, third-person, LLM-extracted fact/decision prose, not chat-log/verbose-note text the technique targets. Confirmed independently via gzip compressibility (real content compresses worse than filler-laden control text of the same length). A model-based paraphrase pass was considered and rejected on cost/latency grounds for content this short (a few sentences per memory); might be worth revisiting only if memory content shape changes to hold much longer text (paragraphs/documents). | CHANGELOG.md Unreleased entry, issue #286 closing comment |

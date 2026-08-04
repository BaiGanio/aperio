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
- 2026-08-01 **A bilingual payment form can silently yield a 10× wrong amount
  in plain text.** `extract-facts.js` `LABEL_FORWARD_WINDOW` scans a fixed 20
  characters after a money label for a currency-less number. The corpus's
  payment forms fit by one character ("Сума (Amount):              29,99" is
  exactly 20); a form with one more digit or one more space truncates to
  "235,2", which then parses as 2352 because the comma reads as a thousands
  separator. Not reachable through the real corpus today — DOCX extraction
  collapses the padding — but a plain-text form with wider columns hits it, and
  the failure is silent and financial. Fix is to bound the scan by end-of-line
  rather than a character count.
- 2026-08-01 **Image-only receipts still contribute nothing.** PNG receipts
  yield `no_text` and are recovered only when a bank-statement row happens to
  cover them. All nine corpus months now reconcile exactly, but that is because
  every image-only receipt in this corpus has a statement row or a `.txt`
  sibling; a household whose receipts are photos only would come up short. The
  deterministic path needs the native-vision seam to close this properly.

---

## Tool profiles / schema budgeting

- 2026-08-02 `SMALL_WINDOW_TOKENS` defaults to **32768** in code
  (`lib/agent/tool-profiles.js:105`) but the registry documents **8192**
  (`lib/config.js:224-226`), and registry defaults are never injected into
  `process.env` (`lib/config.js:565-578`). The tool-count cap therefore fires on
  far more models than the documentation implies. Found while auditing schema
  budgeting for the Git co-pilot map (#345/#346).
- 2026-08-02 `capToolsForWindow` **`break`s** on the first tool that overflows the
  `0.20 × contextWindow` budget rather than skipping it
  (`lib/agent/tool-profiles.js:125-134`), so an over-budget profile is truncated
  mid-set with only a `logger.info` (`lib/agent/index.js:239`). Benign for
  read-only profiles; becomes a correctness problem for any future tool group
  where a partial set is worse than none. Tracked as a decision in #354.

---

## Terminal — resume doesn't rebind session identity

- 2026-08-04 `handleResume()` (`lib/terminal/standalone.js:332`) never
  reassigns the outer `sessionId` variable to the resumed session's `id` —
  only `providerSessionSourceId` and `state.sessionMessages`' content change.
  Found while fixing the persisted-transcript first-message bug (finaliseSession
  no longer always drops `messages[0]`; see the commit that closed it), which
  needed to audit every place `messages[0]` gets reseeded. Practical effect:
  after `/resume <id>` in the CLI, every subsequent turn is still written to
  the OLD (pre-resume) session file on exit/restart — the resumed session's
  own file is never updated with the new turns, and its `endedAt` is never
  re-stamped. No test currently exercises `/resume` end-to-end. The `ws` path
  (`handleResumeSession` in `lib/emitters/handlers/ws/session.js`) does this
  correctly via `switchSessionId()`; the CLI path needs the equivalent
  `sessionId = id` (plus `scratchDir`/`workspaceDirective`/`sessionLogger`
  rebind, mirroring `switchSessionId`) added to `handleResume`.
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

## GitHub tooling — egress logging

- 2026-08-02 The GitHub **write** path logs no egress at all:
  `create_github_issue` / `update_github_issue` POST/PATCH without a `logEgress`
  call (`mcp/tools/github.js:435,451,459`), and `fetch_github_issue`'s primary
  issue + comments GETs are unlogged too (`github.js:104,121`). Only 4 sites call
  `logEgress`, hostname-only, and `var/logs/egress.log` has no rotation, no
  redaction, no size cap, and no explicit file mode (`lib/helpers/egressLog.js:14-19`).
  So "which repo did the agent write to" is not recoverable after the fact. Found
  during the #346 audit.

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
| `coding-examples` skill stub | Merged into `coding-standards`, but the old `SKILL.md` still exists as a "do not load" redirect | Cleanup pass on skills directory |

## Investigated and rejected

Not deferrals — these were built, measured, and found not to work. Do not re-attempt the same
approach without new evidence; a different mechanism may still be worth trying.

| Item | Finding | Evidence |
|------|---------|----------|
| Memory compaction via deterministic filler-phrase rewriting (issue #286, `/caveman-compress` borrow) | Real Aperio memory content contains no removable conversational filler — 0.00% token savings measured against both the capability-exam corpus and every real row in the dev DB. Content is terse, third-person, LLM-extracted fact/decision prose, not chat-log/verbose-note text the technique targets. Confirmed independently via gzip compressibility (real content compresses worse than filler-laden control text of the same length). A model-based paraphrase pass was considered and rejected on cost/latency grounds for content this short (a few sentences per memory); might be worth revisiting only if memory content shape changes to hold much longer text (paragraphs/documents). | CHANGELOG.md Unreleased entry, issue #286 closing comment |

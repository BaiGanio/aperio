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

## Sessions — persisted transcript

- 2026-08-02 **Every session's real first message is silently dropped from its
  persisted transcript.** `finaliseSession` (`lib/helpers/sessions.js:483`,
  and the `isMeaningful`/`deriveTitle` helpers around it) does
  `messages.slice(1)`, documented as "skip the internal greeting prompt at
  [0]" — but nothing in the current ws or CLI flow ever seeds a synthetic
  message at index 0 (`wsHandler.js`'s comment at ~L272 confirms the greeting
  is deliberately NOT put into `messages`; `handleChat`'s first `messages.push`
  is the user's real first turn). Verified directly against the real code
  path (not just reading): a 4-exchange session's opening user message never
  appears in the saved `s.messages`. Only affects the FIRST-EVER finalise of a
  session — `[0]` genuinely IS synthetic (the resume/branch context note) on
  every subsequent finalise of a resumed/branched session, per the round-12
  `isContinuation` fix in the same function, so this is a distinct bug, not
  the one that fix addressed. Likely explains why History/RAG on any given
  conversation seem to be missing its opening line. Needs its own review: the
  fix must distinguish a genuine synthetic first entry (resume/branch) from an
  ordinary first user turn, which this function currently has no way to tell
  apart.

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

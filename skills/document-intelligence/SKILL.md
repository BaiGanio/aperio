---
name: document-intelligence
description: >
  Use this skill when the user asks a money question that spans their indexed
  documents — bills, receipts, statements, invoices — and wants a total, a
  category breakdown, or a spending aggregate, rather than the text of one
  document. Teaches the verified retrieval flow: discover indexed locations,
  build a bounded manifest, batch-read with coverage accounting, then let SQL
  (never mental arithmetic) produce the final figure. Covers writing verified
  rows to a queryable extraction destination and keeping currencies separate.
metadata:
  keywords: "how much did i spend, how much did i pay, how much do i owe, total spending, spending this month, spending by category, broken down by category, category totals, monthly total, monthly expenses, total expenses, add up my bills, sum my receipts, total from my bills, my total spending, spending last month, total i paid, how much have i spent, total amount i paid, sum of all my bills, pay for utilities, spend on utilities, spent on utilities, utility bills, utilities bill, pay for groceries, spend on groceries, spent on groceries, grocery bills, grocery receipts, pay for fuel, spend on fuel, spent on fuel, fuel receipts, fuel bills, pay for internet, spend on internet, spent on internet, internet bill, pay for transport, spend on transport, spent on transport, transport receipts, pay for rent, electricity bill, water bill, heating bill, phone bill, insurance bills, tally up my, total up my, been charged"
  category: "document-extraction"
  load: "on-demand"
---

# Document Intelligence

Aggregates amounts across the user's indexed documents — utility bills, fuel
receipts, grocery/transport statements, invoices — into a verified total or
category breakdown, backed by `docgraph`'s retrieval tools and `database`'s
SQL tools. Nothing here assumes a folder name, a table name, or a fixed set
of categories: everything is discovered at runtime.

---

## Boundary with other tools (read this first)

- **One document's content, or "where did I write/mention X"** → `docgraph`
  (`doc_search`/`doc_context`/`doc_outline`). This skill is for aggregating
  **amounts across multiple documents**, not for reading or summarizing one.
- **Ongoing tracked expense categories, budgets, saved preferences** → `memory`
  or `wiki` if the user is asking about something they already told Aperio,
  not something that lives in a document.
- **"Save/keep/persist the results so I can query them again"** — this
  always means the `extraction` database via `db_execute`, **never**
  `remember`/`wiki`. A memory entry is a text note, not queryable rows —
  writing one instead of a `db_execute` proposal does not satisfy a save
  request for computed figures, even if the note is accurate. If you find
  yourself reaching for `remember` to store a total or a breakdown, stop:
  that's this skill's job via step 5 below, not memory's.
- **A destination that already has rows in it** (the user asks to query
  extracted data they know exists) → go straight to `db_schema`/`db_query` on
  the `extraction` connection; you don't need a fresh retrieval pass.
- **One document of a shape Aperio has seen before** (this month's electricity
  bill, the same landlord's invoice again) → the `extraction_*` tools in
  step 7 extract its fields against a learned template instead of re-deriving
  them. That path is for *one recognized document*; the manifest/batch flow
  above is still what answers a "total across everything" question.
- When unsure whether documents are indexed at all, call `doc_repos` first —
  don't guess a folder name from the question.

## When to use

- "How much did I pay for utilities last month?"
- "What did I spend in total in June, broken down by category?"
- "Add up my fuel receipts for this quarter."
- "How much have I spent on groceries this year?"
- Any question whose honest answer requires reading more than one document
  and summing values found in them.

## When NOT to use

- The user names one specific document and wants its content or a single
  field from it → read it directly (`doc_context`/`doc_batch` with one
  candidate is fine, but this skill's coverage/aggregation machinery is
  unnecessary ceremony for a single known file).
- No indexed documents exist yet → say so plainly; do not fabricate a total.

---

## Canonical flow

```
unknown scope   → doc_repos    (which folders are indexed at all — never assume one)
build scope     → doc_manifest (bounded, deterministic candidate list for the question/period)
read + evidence → doc_batch    (bounded batch read; per-document dates/amounts + coverage
                                 + a deterministic `aggregate`, computed by application code)
persist (opt.)  → db_execute   (propose a write to the `extraction` connection; user confirms)
verify the save → read the confirm ack's rowsAffected — a CREATE TABLE is not a save
final figure    → db_query     (SQL SUM/GROUP BY — the number you report, never hand math)

recognized doc  → extraction_template_match → extraction_apply → db_execute → extraction_log_record
                                 (step 7 — one already-learned document shape, not a whole corpus)
```

### 1. Discover before assuming

Call `doc_repos` when you don't already know which folders are indexed, or
when the user's phrasing doesn't name a location. Never hardcode a folder
name, guess "the first folder," or assume last-used location — the same
question can be answered from a different profile with different indexed
paths.

### 2. Build a bounded manifest

Call `doc_manifest` with the user's question as `query`. Pass `folder` only
if the user named one explicitly. If the question names a month, prefer
letting `doc_batch`'s `aggregate_period` do the period filtering (below)
over narrowing the manifest by date yourself — the manifest's job is
candidate discovery, not period math.

### 3. Batch-read once, not per file

Pass **all** manifest candidates to a single `doc_batch` call — never one
`doc_batch`/`doc_context` call per file. If the question names a month, set
`aggregate_period` (`"YYYY-MM"`) so `doc_batch`'s own deterministic
`aggregate` field scopes correctly and lists out-of-period documents under
`aggregate.excluded` instead of silently dropping or including them.

Before reporting anything, read the coverage the tool already gives you:
how many candidates were found, how many were actually read, which were
skipped and why. State this coverage in your answer — "N of M candidate
documents read; 1 skipped (unreadable scan)" — don't silently report a
partial result as complete.

`doc_batch`'s `highlights` field and per-document `amounts[].label` are a
fast way to orient yourself, but they're filename/label heuristics —
cross-check against the document `text` before trusting a figure, and treat
`label: "likely_total"` as lower confidence than a real label.

**If the manifest's bound doesn't cover the question's full scope** (a
multi-month or whole-year question against a large indexed corpus routinely
exceeds `doc_manifest`'s candidate cap), do **not** work around the gap by
fetching the remaining documents one at a time with `doc_context` — that
recreates the slow, unbounded per-file crawl this whole flow exists to
avoid, and it will not finish in a reasonable time against a large corpus.
Instead, either: narrow the question yourself (answer one period at a time,
saying so — "June only; ask me for the next month to continue"), or issue
one more bounded `doc_manifest`/`doc_batch` pair scoped to the remaining
period/category. If neither closes the gap within a reasonable number of
calls, stop and report exactly what you covered and what's left, rather
than continuing to fetch documents individually until you run out of time.

### 4. The final figure comes from code, not from you

`doc_batch`'s `aggregate` field is already computed by application code
(per currency, per category, duplicates merged, uncountable documents
excluded with a reason) — that is a legitimate, cite-able source, not a
model guess. If the user only wants a one-off answer with no request to
keep or requery it, you may report `aggregate`'s totals directly, with the
coverage from step 3 and a plain statement that this wasn't persisted.

**If the user asks to save, keep, persist, track, or query the result
again later, that is a `db_execute`/`db_query` request, full stop** — not
optional, and not satisfiable by writing a `remember`/memory note instead
(see the boundary section above). Normalize each row's amount with
`db_normalize_amount`, write the normalized rows to the `extraction`
connection with `db_execute` (see below), and once the write is confirmed,
derive the number you actually report with a `db_query` `SUM(...) GROUP BY
currency` (and `category`, if the question asked for a breakdown) against
those rows. That query result — not your own addition, and not a re-typed
copy of `aggregate` — is the figure you state, and you cite the row/category
counts the query returned.

If no destination exists and the user explicitly wants persistence, say so
and offer to create one (below) rather than doing an unpersisted, uncitable
mental sum in its place.

**One payment is often documented more than once. Count the event, not the
documents.** Two things above are in tension: `aggregate` merges duplicates,
but the moment you hand-build rows for an `INSERT` you are re-deriving from
the raw documents and that merge is gone. The two shapes that recur:

- **The same document in two formats.** A receipt saved as both `.txt` and a
  `.png` scan, carrying the same receipt or invoice number and the same
  printed content, is one document photographed twice — not two purchases.
- **A receipt and a bank-statement row for the same purchase.** Matching
  merchant, transaction date, amount and currency, with card evidence on
  both, means the statement line *is* that receipt's payment showing up in
  the bank's records. Counting both turns one purchase into two.

And the harder half, which is why "merge anything that looks alike" is not
the rule: **equal amounts never establish duplication, and neither does the
same merchant on the same card.** Two fills at the same petrol station,
paid with the same card, on different dates are two separate purchases;
collapsing them understates the total exactly as badly as double-counting
overstates it. You need a shared identifier, or the full tuple —
merchant, date, amount, currency, card evidence, document role — before
you merge anything.

The check that costs you nothing: before proposing the write, compare your
per-category totals against `aggregate`'s. If a category of yours comes out
higher, you have counted one event twice; if lower, you have dropped or
wrongly merged one. Either way, resolve it before the `INSERT`, not in the
narration afterwards.

### 5. Writing to the extraction destination

`db_execute` writes are propose-then-confirm — you call `db_execute` once to
propose the statement, then stop; the user confirms and the server executes
it. Never set `confirmation_token` yourself and never call `db_execute` a
second time to "retry" a proposal.

- **Before your first `db_query` or `db_execute` against `extraction` in a
  conversation, confirm the connection/table actually exists** — call
  `db_schema`, or recall your own already-confirmed `CREATE TABLE`, rather
  than guessing a table name and querying it directly. Recorded live: asked
  to "query it per category," a run issued a `SELECT` against a table name
  it invented on the spot, before ever creating it — the query's own error
  ("no connection named extraction") was the first and only signal the table
  didn't exist. A `db_schema` check first surfaces the same fact without
  spending a turn on a doomed query.
- **Before a second or follow-up save attempt on a table you (or an earlier
  turn) already wrote to** — a prompt like "finish saving them," "did the
  rest go in?," or anything implying resumed/incomplete work — run
  `db_query`/`db_schema` first to see what rows already exist. Never
  re-derive the full row set from the source documents again from scratch;
  that is how fabricated data ends up in the table (placeholder hashes,
  invented category labels, amount/original-string pairs shuffled across
  documents) instead of a duplicate of the real values you extracted the
  first time. Insert only the rows that are actually missing, using the same
  real per-document values already confirmed earlier in the conversation —
  not new ones you make up to fill the gap.
- **Describing a save you're about to do is not the same as doing it — the
  turn that says "I'll insert this now" must contain the `db_execute` call
  itself, not just the sentence.** Recorded live: given explicit permission
  ("a single multi-row INSERT is fine") on a table that already existed, a
  turn produced only prose — no tool call at all — and the next turn
  reverted to re-reading a source document instead of inserting. If you
  notice yourself about to end a turn having only stated an intent to save,
  call `db_execute` before ending the turn instead of stating the intent
  again next turn.
- Connection name is always `extraction` — it doesn't need to exist yet; it
  is provisioned automatically as the user's own writable SQLite database on
  first confirmed write. Never invent or ask for a different connection name.
- You choose the table/column names in your own `CREATE TABLE` — never
  derive them from a folder path, filename, or document title.
- Amount fields are normalized numbers plus an ISO currency
  (`db_normalize_amount`) before they go in a numeric column. Keep the
  original source string in its own text column — templates and later
  extraction passes rely on the source string surviving unmodified.
- **Never split one logical save into multiple single-row confirms, even if
  you extracted the rows one document at a time.** `db_execute` allows
  exactly one statement per call, but a multi-row
  `INSERT ... VALUES (...), (...), ...` is still one statement — hold every
  row for one save in memory until the batch is complete, then write it as a
  single `INSERT`. This isn't just a wasted click: each confirm is a full
  extra conversation turn, and on a local model an extra turn can force a
  full prompt-cache reprocess (minutes, not seconds) rather than a marginal
  cost — recorded live: a 12-row save issued as 12 separate confirms instead
  of one. If a prompt explicitly says a multi-row `INSERT` is acceptable,
  that is not permission to still do it per row.
- Every value goes through `params`, never concatenated into `sql` — and the
  number of entries in `params` must match the number of placeholders in the
  statement. A mismatch is rejected when you propose it, with a count in the
  error; fix the array to match, don't work around the rejection by inlining
  the values into the SQL string.
- **A multi-row `INSERT`'s `VALUES` clause needs one placeholder tuple per
  row — `params` alone can't carry multiple rows through a single tuple.**
  For N rows of a 7-column table: `VALUES (?,?,?,?,?,?,?), (?,?,?,?,?,?,?),
  ...` repeated N times, comma-separated, with `params` as one flat array of
  exactly N×7 values in the same row-then-column order as the tuples. If
  `db_execute` rejects the proposal with an "expects X but Y were provided"
  error on a multi-row insert, the fix is almost always to add more tuples to
  the `VALUES` clause to match your row count — not to reshape `params`.
  Recorded live: three straight retries on a 13-row save each changed
  `params`'s shape (65 flat values → 91 flat values → a nested array of 13
  seven-value tuples) while the SQL text kept exactly one 7-placeholder
  tuple the whole time, so the mismatch never resolved. Count your rows,
  write that many tuples, then build one flat `params` array of
  rows × columns values — in that order, every time.
- Automatic/repeated inserts for a recognized document shape are opt-in per
  template and still require the user's confirmation on each write; nothing
  here silently learns a template and writes without asking. See step 7.
- Show the normalized rows you're about to write before proposing the
  insert, so the user can catch a bad extraction before it's committed.

**Then verify the write actually landed, before saying anything was saved.**
The confirm acknowledgment reports `rowsAffected` — read it. A confirmed
`CREATE TABLE` returns `rowsAffected: 0` and saves no data; a table now
exists and it is empty. This is a real, recorded failure: a run created the
table, never issued the `INSERT`, then reported a category breakdown from its
own earlier arithmetic when the follow-up `db_query` came back with zero
rows. If a query returns no rows, the correct response is to finish the
`INSERT` (one multi-row statement) and re-query — **never** to fall back on
remembered numbers. Reciting a total the database does not contain is the
single failure this whole flow exists to prevent, and saying "I couldn't
query it, so here is what I extracted earlier" does not make it acceptable.

### 6. Currency: never blend, never convert

Aggregate strictly by currency. If a document set spans BGN and EUR, report
two totals, not one converted figure — and say plainly that no conversion
was applied. If you find yourself reaching for an exchange rate to produce
a single number, stop: that is the one thing this skill must never do.

This includes the closing line. Correct per-currency tables followed by an
"Overall Grand Total: 893.24 (696.84 BGN + 196.40 EUR)" is a failure, not a
courtesy — adding two currencies is an implicit exchange rate of 1.0, which
is simply a wrong one. Getting it right earlier in the answer does not earn
the summary line. When the user asks for "the total" and the documents span
currencies, the honest answer is two totals plus one sentence saying why
there is no single number.

**Before you send the final answer, re-read every line for two amounts in
different currencies added into one figure.** A "Grand total" line placed
right after correct per-currency lines is the most common place this slips
through — it reads as a helpful summary rather than a calculation, which is
exactly why it's easy to add without noticing. If you find one, delete it;
recorded live on a run that got every per-currency line right and still
added `**Grand total: 893.24** (696.84 BGN + 196.40 EUR)` as a closing
sentence.

### 7. Reusing a learned document shape (templates)

When the work is *one document Aperio has seen the shape of before*, don't
re-derive its fields from raw text — run it against the learned templates:

```
extraction_template_match(text)   → status: confident | ambiguous | none
  confident → extraction_apply(text, template)   (regex/label first, one targeted
                                                  LLM lookup only for what's left;
                                                  returns per-field provenance,
                                                  a confidence, and a sourceHash)
  ambiguous → name a template explicitly; don't guess between two close scores
  none      → extraction_template_propose(...)   (confirm-before-save, same contract
                                                  as db_execute — propose once, stop),
                                                  or just fall through to the ad-hoc
                                                  CREATE TABLE/INSERT flow above
```

Two contracts here are easy to skip and silently break the feature:

- **Carry `sourceHash` into the write.** `extraction_apply` returns a
  `sourceHash`; include it as one of your `INSERT`'s column values (e.g. a
  `source_hash` column). It has to appear among the confirmed statement's own
  bound parameters or the write cannot be verified afterwards.
- **Record the extraction after the write is confirmed.** Call
  `extraction_log_record` exactly once, passing that same `sourceHash` and
  the `db_execute` `confirmation_token` as `db_execute_token`. Nothing does
  this for you. Skip it and the same document can be silently re-extracted
  and double-counted later — `extraction_apply`'s duplicate detection reads
  the log, and an unwritten log is an empty one.

`extraction_log_check` answers "was this already extracted?" on its own, and
`extraction_apply` returns the prior log entry instead of re-running when the
source is a known duplicate. `extraction_template_delete` removes only the
template definition — already-extracted rows and log entries stay.

---

## Gotchas

- **Don't loop `doc_batch` per file, and don't fall back to `doc_context`
  per file either.** Both recreate the slow, unbounded per-document crawl
  the bounded-manifest design exists to avoid. If one batch doesn't cover
  the full scope, get a second bounded manifest/batch for what's left, or
  narrow the question and say so — never fetch the remainder one document
  at a time.
- **A document in the manifest is a candidate, not a confirmed expense.**
  The manifest ranks by relevance to the question, and relevance is not the
  same as belonging in the answer. Recorded false positives from real runs: a
  B2B steel/freight commercial invoice (~€1.27M) reported as a household
  spending category, and EUR travel receipts saved into `Transport`/`Dining`
  alongside domestic BGN spending. Before a document contributes to a
  category, satisfy yourself from its own body that it is the user's own
  spending, in the period asked about — tax notices, business invoices,
  blank templates, and quotes all read as money-shaped to a ranker.
- **A hotel, taxi, train, bus, or airport-meal receipt tied to a trip away
  from home is travel spending, not household spending — exclude it from
  every category total regardless of currency, even though it genuinely is
  the user's own money.** This is a different test than the one above: "is
  this the user's own spending" isn't enough on its own, since a train
  ticket the user paid for really is their spending. The signal is the
  document *kind* (lodging/taxi/rail/bus/airport-meal framing) plus a
  destination that doesn't match the user's home documents — a foreign city,
  a foreign language, a passenger or guest name matching the user rather
  than a household account holder. Don't confuse this with an ordinary
  purchase that merely happens to be billed in a foreign currency (e.g. an
  online order from a foreign merchant) — that IS legitimate spending and
  belongs in its own per-currency total per §6, just never blended into the
  home-currency figure. If you mention an excluded travel document at all,
  say plainly that it's excluded and why. Recorded live: a run reported one
  of three excluded EUR travel receipts as `EUR | Transport | 49.90` inside
  a category-breakdown table, with no exclusion disclosure — on a run where
  the more general "candidate, not a confirmed expense" bullet above already
  existed and named this same failure shape without stopping it. Treat this
  as a standing risk to re-check on every run, not a solved problem.
- **`file_mtime` is not the document's date.** It's a filesystem timestamp.
  Use each document's own extracted `dates` (or read `text`) for anything
  date-sensitive.
- **A missing `dates`/`amounts` entry means "not detected," not "zero" or
  "not present."** Fall back to `text` before concluding a document
  contributes nothing.
- **Category hints in `highlights` are filename-based guesses.** Verify
  against the document body before reporting a category.
- **`db_query` is read-only and capped** (200 rows default, 1000 max) — add
  your own `WHERE`/`GROUP BY` rather than pulling everything and summing in
  your head; that defeats the entire point of routing the arithmetic through
  SQL.
- **The built-in `aperio` database connection stays read-only.** It is never
  a valid target for extracted document data — that's what `extraction` is
  for.
- **Query columns by the name your own `db_schema`/`CREATE TABLE` actually
  used, not the name you remember using.** A query against a column typed
  from memory (e.g. `amount` when the table was created with
  `amount_normalized`) fails outright — re-read the exact column list from
  the schema you already have in this conversation before writing the next
  query against it, rather than retyping it from recall.

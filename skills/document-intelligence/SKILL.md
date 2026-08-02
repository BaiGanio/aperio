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
final figure    → db_query     (SQL SUM/GROUP BY — the number you report, never hand math)
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

### 5. Writing to the extraction destination

`db_execute` writes are propose-then-confirm — you call `db_execute` once to
propose the statement, then stop; the user confirms and the server executes
it. Never set `confirmation_token` yourself and never call `db_execute` a
second time to "retry" a proposal.

- Connection name is always `extraction` — it doesn't need to exist yet; it
  is provisioned automatically as the user's own writable SQLite database on
  first confirmed write. Never invent or ask for a different connection name.
- You choose the table/column names in your own `CREATE TABLE` — never
  derive them from a folder path, filename, or document title.
- Amount fields are normalized numbers plus an ISO currency
  (`db_normalize_amount`) before they go in a numeric column. Keep the
  original source string in its own text column — templates and later
  extraction passes rely on the source string surviving unmodified.
- `db_execute` allows exactly one statement per call, but a multi-row
  `INSERT ... VALUES (...), (...), ...` is still one statement — write every
  row for one logical save in a single `INSERT`, not one confirm per row.
  Confirming a whole table's worth of rows one at a time wastes a
  confirmation round-trip per row for no accuracy benefit.
- Automatic/repeated inserts for a recognized document shape are opt-in per
  template and still require the user's confirmation on each write; nothing
  here silently learns a template and writes without asking.
- Show the normalized rows you're about to write before proposing the
  insert, so the user can catch a bad extraction before it's committed.

### 6. Currency: never blend, never convert

Aggregate strictly by currency. If a document set spans BGN and EUR, report
two totals, not one converted figure — and say plainly that no conversion
was applied. If you find yourself reaching for an exchange rate to produce
a single number, stop: that is the one thing this skill must never do.

---

## Gotchas

- **Don't loop `doc_batch` per file, and don't fall back to `doc_context`
  per file either.** Both recreate the slow, unbounded per-document crawl
  the bounded-manifest design exists to avoid. If one batch doesn't cover
  the full scope, get a second bounded manifest/batch for what's left, or
  narrow the question and say so — never fetch the remainder one document
  at a time.
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

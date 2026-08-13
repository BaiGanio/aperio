# Document Intelligence Epic — Quick Status and Harness Guide

Updated: 2026-08-05

This is a compact handoff for `trash/plans/document-intelligence-epic/`. The
canonical evidence remains in `document-intelligence-epic.md`,
`document-intelligence-epic-evidence.md`, and the WS2/WS3 evidence files.

## What has been achieved

- The original red failure was isolated: ordinary document questions did not
  route to document discovery, and the old flow read documents serially or
  relied on incomplete context.
- Retrieval was redesigned around a bounded manifest plus bounded batch reads.
  It discovers indexed repositories at runtime, deduplicates candidates,
  reports coverage/skips, supports text/PDF/native vision, and propagates
  cancellation. The oracle stays outside the model-readable workspace.
- The deterministic fact pipeline and period-aware aggregation are in place.
  The honest June corpus reconciles to **696.84 BGN**: Utilities 260.50, Fuel
  215.60, Groceries 140.75, Transport 50.00, and Internet 29.99. **196.40 EUR**
  is kept separate; no exchange rate is invented.
- T-R5 retrieval passed twice on the local hero model, Gemma 4 E4B, on
  2026-08-01 and 2026-08-02. Both runs used one `doc_batch`, full corpus
  coverage, withheld oracle, isolated ports/SQLite, and clean teardown.
- WS1 is implemented: Aperio provisions the user-facing `extraction` SQLite
  database behind the existing `db_execute` confirmation boundary. Amounts are
  normalized on write, currencies remain separate, and the built-in `aperio`
  connection remains read-only. T-G1.1–T-G1.4 are recorded green, including
  encrypted SQLite handling.
- WS2's document-intelligence skill is implemented. Routing and coverage pass
  on Gemma E4B. The SQL-provenance and no-FX behavior passes on DeepSeek, but
  remains open on Gemma E4B for the actual target-model claim.
- WS3 persistent extraction templates is closed and dual-backend proven:
  mirrored migrations, template CRUD/matching, regex-first extraction with
  targeted LLM fallback, confidence/provenance, confirmed cold-start learning,
  extraction-log hashing/deduplication, all eight MCP tools, web-agent tool
  reachability, and Excel/database round-trip tests. A real isolated scratch
  Postgres run reproduced T-G3.1/T-G4/T-G5/T-G5.2 without code changes.
- Multiple review rounds fixed real safety/reliability gaps: template
  confirmation-token exposure, unverified extraction-log writes, weak
  `db_execute` evidence, unreachable MCP tools, and targeted-fallback wiring.
  The full project suite was recorded green after the shared-tool changes.
- The latency investigation found the remaining local-model bottleneck:
  changing tool-schema sets between turns defeats llama.cpp prompt/KV-cache
  reuse. The Gemma 4 26B simple capability probe passes 4/4, but its full
  document-intelligence turn still misses the UX deadline because of large
  prefill/context cost. This is a latency/workflow issue, not evidence that
  the model cannot do the basic arithmetic.

## Current truth / remaining work

The product plumbing is largely complete. The open gate is the local hero-model
workflow proof (WS2 T-G2.3/T-G2.4, later WS4/T-G6): Gemma E4B created a table
but did not insert rows, then reported a remembered breakdown after an empty
SQL query and blended BGN/EUR into one number. The original grader called this
a pass; the corrected grader and transcript correctly call it a failure.

DeepSeek `deepseek-v4-flash` completed the same provenance phase with a clean
pass. That demonstrates the workflow can solve the problem, but it does not
close the claim that the small local model solves it reliably. The next work is
the llama.cpp multi-turn latency plan and a repeat of the corrected Gemma gate.

## Models used and what each proves

| Side | Provider/model | Role and result |
|---|---|---|
| Target/local | `llamacpp` / `unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL` | Product hero model. T-R5 retrieval passes twice; SQL provenance/no-FX remains open. |
| Target/local | `llamacpp` / `unsloth/gemma-4-26B-A4B-it-qat-GGUF:Q4_K_XL` | Capability/latency follow-up. Simple gate 4/4; full workflow misses the 90-second turn budget. |
| Cloud comparison | `deepseek` / `deepseek-v4-flash` | Clean WS2 provenance pass; kept as comparison, not a local-model proof. |
| Cloud comparison option | `codex` / `gpt-5.6-terra` | Supported by the provenance harness as the other recorded evaluation pair; no retained result here is used as the local-model gate. |
| Implementation/review | Codex session plus local coding-model work | Used for code audit, implementation, review, and harness correction; not the product capability claim. |

The older red harness defaults to DeepSeek `deepseek-v4-pro`, Anthropic to
`claude-haiku-4-5-20251001`, and llama.cpp to Gemma E2B; those are defaults in
the script, not the final WS2 evidence pair.

## Prompts used by the harnesses

These are the literal user prompts currently embedded in the harness source.
The provenance harness may append the follow-ups below conditionally, until a
real SQL query returns rows and the answer narrates its result.

### Retrieval red/T-R5 harness

```text
How much did I spend in total in June 2026, broken down by category?
```

Source: `document-intelligence-red-harness.mjs` (`PROMPTS`).

### WS2 skill harness

Routing:

```text
How much did I pay for utilities in June 2026?
```

Coverage:

```text
What did I spend on utilities across all of 2026? Tell me what you found and what you couldn't cover.
```

Provenance:

```text
Add up everything I spent on documented bills and receipts for June 2026, broken down by category. Save the results so I can query them again later, and give me the total.
```

Conditional provenance follow-ups, in order:

```text
Now give me the category breakdown and the grand total you just saved — query it per category (SUM grouped by category and currency), not from your own arithmetic.
If the rows aren't in the table yet, finish saving them now (a single multi-row INSERT is fine — it's still one statement), then run the per-category SQL query and give me the breakdown and total.
The rows should be saved by now — run SELECT category, currency, SUM(amount) GROUP BY category, currency against the extraction table now and give me the resulting breakdown and total.
Run the per-category SQL query against the extraction table now and state the breakdown and total it returns, in your own words.
You already ran that query earlier in this conversation — just restate its breakdown and total in your own words now, without calling any more tools.
Answer now, in plain prose: what is the category breakdown and grand total from the extraction table you already queried?
```

Source: `llamacpp-latency/document-intelligence-skill-harness.mjs` (`PHASE_PROMPTS` and `followUpPrompts`).

### Simple Gemma capability harness

```text
Calculate 17 × 23 + 19. Reply with only the number.
A price falls from $80 to $68. What is the percentage decrease? Reply with only the percentage.
Three items cost $12.50, $7.25, and $10.25. What is their average cost? Reply with only the dollar amount to two decimals.
All roses are flowers. Some flowers fade quickly. Does it follow that some roses fade quickly? Reply only yes or no.
```

Its fixed system prompt is: `Answer accurately and follow the requested output format exactly.`

### llama.cpp cache probe

This probe does not test document answers. It uses a synthetic conversation:

```text
I'd like help reviewing our household spending for this quarter. Can you walk me through how you'd approach it?
Sure — I'd start by pulling the categorized transactions for the quarter, checking for duplicates or misclassified entries, then summing by category before comparing against last quarter's totals.
Here is additional context you may need: [generated filler repeated to approximately 2,500 tokens]
Understood — I've noted that context and will factor it into the review.
Great — now give me the total for just the transport category.
```

The probe repeats this history with tool sets X, Y, X again, and X+one tool to
measure llama.cpp `cache_n`/`prompt_n`; the tool descriptions are synthetic.

## Manual runs

Run from the repository root. The end-to-end harness creates an isolated scratch
workspace/database, chooses free loopback ports, and cleans up in `finally`.

```bash
# Retrieval/T-R5 against the default configured provider/model
node trash/plans/document-intelligence-epic/document-intelligence-red-harness.mjs

# Setup/corpus/indexing only; useful before spending model time
node trash/plans/document-intelligence-epic/document-intelligence-red-harness.mjs --setup-only

# WS2 routing, coverage, or provenance phase using the default DeepSeek pair
DOCINT_PHASE=routing node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
DOCINT_PHASE=coverage node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
DOCINT_PHASE=provenance node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs

# The actual local Gemma E4B provenance gate
DOCINT_PHASE=provenance DOCINT_EVALUATION_PROVIDER=llamacpp \
  LLAMACPP_MODEL=unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL \
  node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs

# Simple capability fallback for Gemma 26B
LLAMACPP_MODEL=unsloth/gemma-4-26B-A4B-it-qat-GGUF:Q4_K_XL \
  node trash/plans/document-intelligence-epic/llamacpp-latency/gemma-simple-capability-harness.mjs

# Standalone cache/KV reuse measurement
node trash/plans/document-intelligence-epic/llamacpp-latency/llamacpp-cache-probe.mjs
```

Useful overrides include `DOCINT_EVALUATION_PROVIDER=codex` with
`DOCINT_EVALUATION_MODEL=gpt-5.6-terra`, `DOCINT_EVALUATION_MODEL=...`,
`APERIO_HARNESS_TIMEOUT_MS=...`, `PROBE_REPEATS=...`, and `PROBE_CTX=...`.
Do not treat `document-intelligence-run-answers.json` as source truth: it is a
fresh, overwritten diagnostic artifact containing prompts, tool traces, and
raw answers. It is now git-ignored rather than tracked, so a run no longer
dirties the worktree and no `git checkout --` restore step is needed.

## Main evidence files

- `document-intelligence-epic-evidence.md` — retrieval, writable destination,
  and T-R5 evidence.
- `document-intelligence-ws2-tg23-open-issues.md` — corrected Gemma failure
  and DeepSeek pass.
- `llamacpp-latency/README.md` — latency diagnosis and Gemma capability results.
- `document-intelligence-epic-tests.md` — acceptance/test definitions.

WS3's own plan/test/review files (`document-intelligence-ws3-templates*.md`) were
deleted on 2026-08-13 once that workstream closed on both backends; the epic's
evidence log carries the outcome, and `git log -- trash/plans/document-intelligence-epic/`
still has the full review history if it is ever needed.


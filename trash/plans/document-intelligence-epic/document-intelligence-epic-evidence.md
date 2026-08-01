# Document Intelligence — WS0-R Evidence

This file records privacy-safe execution evidence for WS0-R. It contains no
household document text, oracle values, fixture paths, model output, or private
runtime logs.

The harness writes a fresh run file, overwriting—not appending to—the ignored
`document-intelligence-run-answers.json` artifact after each completed prompt and
during cleanup. That artifact intentionally stores the full prompt text, prompt labels,
timing, tool sequences, statuses, raw model answers, and the `expected` gate values so
the next run can be adjusted from observed behavior. It is diagnostic run output, not
ground truth, and must not be committed or used as a model-readable oracle.

## T-R0 red baseline — 2026-07-23

- Source snapshot: `b1edb7cf18ff28a0f4b807ebb8a8876922e9ba38`
- Oracle: withheld and not copied into the model-readable workspace.
- Runtime: no server, MCP process, model process, port, database, or temporary
  workdir was started by this routing reproduction.
- Reproduction method: pure routing classification of the three red prompts,
  with prompt text retained only as the plan-defined labels P1/P2/P3.

| Prompt | `docgraph` profile | `doc_repos` preflight intent | Red observation |
|---|---:|---:|---|
| P1 bare utilities | no | no | only memory/data/self profiles are selected |
| P2 explicit folder/monthly total | no | no | filesystem-project profile is selected; document graph is absent |
| P3 maximally steered | yes | yes | retrieval is reachable only after naming the tools |

Conclusion: the current classifier/preflight path does not make unknown-location
document retrieval available for ordinary money questions. This confirms the
routing failure before retrieval changes and establishes T-R0 red.

## T-R1 trace/design status

The current seam is the document graph read API: inventory is repo-level, search
is passage-level, and context is single-chunk/section-level. WS0-R added a
bounded manifest and batch read contract at that seam, with explicit limits,
per-file status, and abort propagation.

## T-R2–T-R4 implementation evidence — 2026-07-23

- Unit retrieval contract: pass — deterministic manifest, empty/multi-source
  behavior, deduplication, explicit limits, bounded batches, accounting, and
  abort between batches.
- SQLite docgraph integration: pass — manifest discovers/bounds candidates and
  batch reads return complete coverage on the fixture backend.
- Routing/preflight: pass — bare aggregation questions select `doc_manifest`
  and `doc_batch`, and preflight executes one manifest followed by one batch.
- Native vision contract: pass at automated seam level — inline task-shaped
  requests remove image-reading tools for native-vision models and add an
  explicit no-preprocess instruction; generic image bridge tests remain green.

## T-R5 honest-corpus gate — failed 2026-07-23

- Harness: direct production composition root, scratch SQLite, two copied
  fictional indexed folders, non-default HTTP/llama ports, oracle withheld.
- P1: completed in approximately 122 seconds; the harness did not persist the
  answer body, so no exact-total claim is made here.
- P2: timed out at the 180-second acceptance budget while the model was still
  processing the bounded retrieval result.
- P3: not started after the P2 timeout, as required by the stop rule.
- Teardown: graceful shutdown stopped llama.cpp; scratch workdir and DB were
  removed by the harness. No oracle or real household path was sent to the
  model.

Exact failure: the bounded retrieval contract prevents the previous 573k-byte
whole-corpus offload, but the full-month question still does not converge within
180 seconds. WS0-R is not green and WS1/extraction-template plumbing must not
start.

## Gate status

WS0-R is not green: T-R5 failed at P2. Do not begin WS1 or extraction-template
plumbing.

## T-R5 rerun — E2B Q4_K_XL, 300-second budget — failed 2026-07-23

- Harness: same isolated direct-composition-root run; scratch SQLite, 21 copied
  fictional documents across two folders, non-default ports, oracle withheld.
- Model: `unsloth/gemma-4-E2B-it-qat-GGUF:Q4_K_XL`.
- P1: completed in approximately 89 seconds; exact Utilities gate failed.
- P2: completed in approximately 201 seconds; exact full-month gate failed.
- P3: completed in approximately 111 seconds; exact full-month gate failed.
- Oracle exposure: pass. Corpus-fence check: pass.
- Teardown: graceful llama.cpp shutdown completed; scratch workdir/DB removed.

Exact failure: increasing the timeout and switching to E2B produced three
completed responses, but none contained the required exact totals/complete
category coverage. WS0-R remains not green; stop before WS1.

## T-R5 clarified-prompt rerun — failed 2026-07-23

- Prompts now specify 2026-05-01 through 2026-05-31 inclusive, date precedence,
  included categories, exclusions, deduplication, source-level reporting, and
  no-write behavior.
- P1: completed in ~59s; tools `doc_repos`, `doc_search`, `doc_search`; answer
  reported no matching utility data, so the Utilities exact-total gate failed.
- P2: completed in ~47s; tool `doc_repos` only; answer declined the analysis, so
  the full-month exact-total gate failed.
- P3: completed in ~207s; used `doc_repos`, `doc_manifest`, `doc_search`, and
  `doc_context`; answer reported only partial evidence and omitted required
  Groceries/Internet totals, so the full-month exact-total gate failed.
- Oracle exposure, corpus fence, teardown, and diff check passed.
- Raw answers were preserved in the ignored run artifact
  `document-intelligence-run-answers.json`; no handshake transport metadata is
  included.

## T-R5 June-prompt rerun — failed 2026-07-23

- P1, P2, and P3 all completed within the then-active 300-second timeout, in
  approximately 292s, 276s, and 259s respectively.
- All three turns invoked the bounded retrieval path: `doc_manifest` followed by
  `doc_batch`.
- The new P2 invocation check therefore passed; this run did not exhibit the generic
  refusal-without-retrieval failure mode.
- Exact Utilities, category, grand-total, coverage, and exclusion gates failed.
- Oracle exposure, corpus fence, and graceful teardown passed.
- The run was started before the artifact-schema update, so its JSON has the old
  300-second metadata and lacks the full `prompt`/`expected` fields. The harness is now
  configured for a fresh 180-second run file with those fields.

## T-R5 Gemma 4 E2B rerun — failed 2026-07-27

- Model: `unsloth/gemma-4-E2B-it-qat-GGUF:Q4_K_XL`; isolated scratch SQLite
  harness with dedicated HTTP/llama ports.
- The first attempt was infrastructure-only: llama-server could not bind its
  dedicated localhost port. The retry with local process/socket permission
  started successfully and is the measured result below.
- Corpus indexing: 18/18 primary documents and 1/1 secondary document.
- Retrieval: one `doc_batch`, full 47.3 KB coverage.
- P1: completed in 230.3s; category gate passed for Internet and Transport,
  but failed Fuel, Groceries, Utilities, and the grand total.
- EUR-travel exclusion, excluded-document leak, oracle exposure, and corpus
  fence checks passed.
- No timeout occurred; the run completed within the prior explicit 300-second
  budget. The harness default is now 600 seconds for future runs.
- Graceful teardown completed; scratch runtime data and model process were
  cleaned up.

## T-R5 Ornith 1.0 9B rerun — failed 2026-07-27

- Model: `protoLabsAI/Ornith-1.0-9B-MTP-GGUF:Q4_K_M`; isolated scratch SQLite
  harness with the 600-second default timeout.
- llama-server loaded successfully; corpus indexing was 18/18 primary and 1/1
  secondary documents.
- Retrieval: one `doc_batch`, full 47.3 KB coverage.
- P1: completed in 292.5s; category gate passed Internet and Transport, but
  failed Fuel, Groceries, Utilities, and the grand total.
- The answer used the bank statement's 260.75 BGN total instead of the expected
  696.84 BGN; the statement-shortcut failure signature was detected.
- EUR-travel exclusion, excluded-document leak, oracle exposure, and corpus
  fence checks passed.
- Graceful teardown completed; scratch runtime data and model process were
  cleaned up.

## T-R5 Gemma 4 E4B rerun — PASSED 2026-08-01 (deterministic pipeline)

- Model: `unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL`; isolated scratch SQLite
  harness with dedicated HTTP/llama ports; oracle withheld; fixture set T-R5
  (2026-06). This is the first T-R5 live pass on a local model.
- Corpus indexing: 18/18 primary and 1/1 secondary documents; retrieval: one
  `doc_batch`, full 55.8 KB coverage; the turn invoked retrieval directly
  (`toolSequence: [doc_batch]`) and answered from the deterministic
  `aggregate` rather than free-form arithmetic.
- P1 (full-month question) completed in 372.6s, within the 600s budget.
- Gate: all checks pass — Utilities 260.50, Fuel 215.60, Groceries 140.75,
  Transport 50.00, Internet 29.99; grand total 696.84 BGN; EUR 196.40 reported
  separately; no failure signatures (no statement shortcut, no receipt↔statement
  double-count); no excluded leak; full per-event coverage; retrieval invoked;
  no oracle exposure; clean corpus fence.
- Teardown: graceful llama-server shutdown; scratch workdir/DB removed. The
  harness's fresh run record overwrote the tracked
  `document-intelligence-run-answers.json`; that file was restored to its
  committed state and is flagged in A2D as tracked against the plan's rule.

## T-R5 Gemma 4 E4B rerun — failed 2026-07-27

- Model: `unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL`; isolated scratch SQLite
  harness with the 600-second default timeout.
- llama-server loaded successfully; corpus indexing was 18/18 primary and 1/1
  secondary documents.
- Retrieval: one `doc_batch`, full 47.3 KB coverage.
- P1: completed in 278.1s; category gate passed Groceries, Internet, and
  Transport, but failed Fuel, Utilities, and the grand total.
- Fuel was attributed as 335.60 instead of 215.60; Utilities as 250.50
  instead of 260.50; the BGN total was 806.84 instead of 696.84. The separate
  196.40 EUR travel total was excluded correctly.
- EUR-travel exclusion, excluded-document leak, oracle exposure, and corpus
  fence checks passed.
- Graceful teardown completed; scratch runtime data and model process were
  cleaned up.

## T-R5 Gemma 4 26B A4B rerun — failed 2026-07-27

- Model: `unsloth/gemma-4-26B-A4B-it-qat-GGUF:Q4_K_XL`; isolated scratch SQLite
  harness with the 600-second default timeout.
- llama-server loaded successfully; corpus indexing was 18/18 primary and 1/1
  secondary documents.
- Retrieval: one `doc_batch`, full 47.3 KB coverage.
- P1: completed in 472.5s; category gate passed Groceries, Internet, Transport,
  and Utilities, but failed Fuel and the grand total.
- Fuel was attributed as 335.60 instead of 215.60; the BGN total was 816.84
  instead of 696.84. The separate 196.40 EUR travel total was excluded
  correctly.
- EUR-travel exclusion, excluded-document leak, oracle exposure, and corpus
  fence checks passed.
- Graceful teardown completed; scratch runtime data and model process were
  cleaned up.

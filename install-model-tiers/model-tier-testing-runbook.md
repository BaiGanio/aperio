# Aperio Local-Model Tier Testing Runbook

**Purpose:** Select evidence-backed llama.cpp defaults for Aperio's 8, 16, 24, and
32 GB RAM installation tiers, while recognizing compatible GGUF models already on
the user's machine.

**Primary selection criterion:** Reliable use of Aperio's memory and tools under
the real system prompt and tool schemas. General chat, coding, and reasoning
benchmarks are supporting evidence, not the deciding evidence.

**Related material:**

- `model-tiers-research.md` — current candidate shortlist and GGUF facts
- `model-tiers-research-2.md` — older research retained for comparison
- `install-model-tiers/configurable-model-tiers.md` — earlier implementation plan
  for configurable tier defaults and GGUF-derived sizing
- `install-model-tiers/configurable-model-tiers-tests.md` — companion acceptance
  tests for that implementation plan
- `.github/capability-exam/exam.md` — agent-operated full capability exam
- `docs/exam/capability-exam.html` — human-operated exam and scorecard

This runbook separates the bounded pilot workflow from catalog-wide campaign
execution. Commands below are available only where the current implementation
and package scripts provide them.

### Current implementation status — 2026-07-14

The bounded runner now exists at `scripts/model-tier-bench.js` and is available
through `npm run model-tier:pilot`. It supports exact cached-model preflight, the
14-case qualification catalog, a five-case pilot funnel, isolated application and
llama.cpp ownership, fixture import/readiness checks, load-versus-qualification
metrics, retry state restoration, private artifacts, tier admission metadata,
non-live campaign planning and aggregation, and catalog-wide campaign execution.

The pilot remains a five-case qualification run for one placement. Campaign
execution consumes the private plan and invokes that lifecycle for every eligible
catalog placement. It does not integrate the score viewer. Offline review ranks
only already-valid, comparable evidence and can generate finalist manifests and
tier decisions. Use
`--validate` for a non-live contract check, and always supply both `--model` and
`--tier` for a live pilot run.

The full-exam execution contract is tracked in
`.github/model-tiers/full-exam.json`. It enumerates all 65 scored drills from the
capability-exam sections and expands the four recall plus four chain groups to
three observations each, for 81 required observations. Each finalist evidence
record must identify the manifest, provide every drill/repetition observation
with tool results and state verification, and reference the required private
artifacts under `var/benchmarks/model-tiers/`. The validator rejects missing,
duplicate, unexpected, or incomplete observations before tier decisions are
generated.

The checked-in catalog contains 15 unique candidates expanding to 38 eligible
tier/model placements through the entries' `tiers` arrays. Each entry has a stable ID, exact repository and
quantization metadata, approximate pre-download size, tier eligibility, role,
and a dated Hugging Face repository verification record. `--validate` checks
those fields before any process starts. Models whose serving reference is a
repository without a tag must still declare their quantization explicitly;
gpt-oss is the current MXFP4 example.

To aggregate existing runs without starting Aperio or llama.cpp:

```bash
npm run model-tier:pilot -- --aggregate --tier 16 --campaign <campaign-id>
```

This writes private `summary.json` and `summary.csv` to
`var/benchmarks/model-tiers/16gb/<campaign-id>/`. Completed runs with failed
cases remain model failures; `status: "invalid"` runs remain
harness/environment evidence and are excluded from model scoring. Valid runs
with mismatched campaign controls are retained as `incomparable` and excluded
from the comparable row set.

To select at most two finalists per tier from an existing summary, without
starting Aperio or llama.cpp:

```bash
npm run model-tier:pilot -- --finalists --tier 16 --campaign <campaign-id>
```

This writes private `finalists.json` beside the campaign summary. It records the
65-drill full exam and the four recall plus four chain cases that must be
observed three times. After separately supplying already-valid finalist exam
evidence, generate the private tier decisions:

```bash
npm run model-tier:pilot -- --decide --tier 16 --campaign <campaign-id> \
  --evidence /private/path/finalist-evidence.json
```

The decision gate requires complete 65-drill evidence, three critical-repeat
observations, 4/4 recall, at least 3/4 chains, 2/2 guardrails, zero persistent
tool failures or unsafe effects, at least 8,192 served context, no material swap
growth, and no model crash or empty completion after retry. This step generates
`decisions.json` and `decisions.md`; it does not execute the full exam or change
installer behavior.

The `install-model-tiers` plan is useful input, not an implementation script to
follow verbatim. Its configurable-tier work remains relevant, but its proposed
GGUF parser and sizing work has since landed through
`lib/helpers/ggufModelFacts.js` and the cached-model inspection path. Re-audit the
current code and update that plan before executing it; do not create a second GGUF
parser or remove current catalog entries merely because the older plan says to.

---

## 1. Outputs of this work

The testing campaign must produce four kinds of evidence:

1. **Per-model result:** exact model, quant, context, scores, tool-call behavior,
   speed, RAM, and swap measurements.
2. **Cross-model matrix:** one comparable row per tested model.
3. **Tier decision:** a default, one fallback, and any compatible alternatives for
   each RAM tier.
4. **Installer catalog data:** stable model IDs, download targets, sizes,
   compatibility facts, minimum RAM, and selection status.

A model is not a tier default merely because its weights fit. It must pass the
hard behavioral gates in section 10 without causing unacceptable swap or latency.

---

## 2. Candidate set

Use exact Hugging Face repository and quantization identifiers. Before starting a
campaign, verify each identifier still resolves and record the exact GGUF byte
size. Do not silently substitute another quantization during a run.

### 8 GB

| Candidate | Download target | Role |
|---|---|---|
| Gemma 4 E4B IT QAT | `unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL` | Provisional default |
| Qwen3.5 4B | `unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL` | Primary challenger |
| Ministral 3 3B Instruct | `mistralai/Ministral-3-3B-Instruct-2512-GGUF:Q4_K_M` | Tool-calling challenger |
| Granite 4.0 H Tiny | `unsloth/granite-4.0-h-tiny-GGUF:UD-Q4_K_XL` | Hybrid-MoE challenger |

### 16 GB

| Candidate | Download target | Role |
|---|---|---|
| Qwen3.5 9B | `unsloth/Qwen3.5-9B-GGUF:Q4_K_M` | Provisional default |
| Ministral 3 14B Instruct | `mistralai/Ministral-3-14B-Instruct-2512-GGUF:Q4_K_M` | Primary challenger |
| Granite 4.1 8B | `ibm-granite/granite-4.1-8b-GGUF:Q4_K_M` | Long-context challenger |
| gpt-oss-20b | `ggml-org/gpt-oss-20b-GGUF` | Tight-fit MoE challenger |

Treat gpt-oss-20b as a special case: it uses MXFP4 and the Harmony response
format. A run is invalid if the serving stack does not apply the correct template.

### 24 GB

| Candidate | Download target | Role |
|---|---|---|
| Gemma 4 26B-A4B IT | `unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_XL` | Provisional default |
| Mistral Small 3.2 24B | `unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF:UD-Q4_K_XL` | Structured-output challenger |
| Granite 4.1 30B | `ibm-granite/granite-4.1-30b-GGUF:Q4_K_M` | Hybrid challenger |
| gpt-oss-20b | `ggml-org/gpt-oss-20b-GGUF` | Comfortable MoE alternative |
| Qwen3.6 27B | `unsloth/Qwen3.6-27B-GGUF:Q4_K_M` | Borderline dense challenger |

### 32 GB

| Candidate | Download target | Role |
|---|---|---|
| Qwen3.6 35B-A3B MTP | `unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL` | Provisional default |
| Qwen3.6 27B | `unsloth/Qwen3.6-27B-GGUF:UD-Q4_K_XL` | Dense challenger |
| Gemma 4 26B-A4B IT | `unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_XL` | Headroom alternative |
| Devstral Small 2 24B | `ggml-org/Devstral-Small-2-24B-Instruct-2512-GGUF:Q4_K_M` | Agentic-code challenger |
| Granite 4.1 30B | `ibm-granite/granite-4.1-30b-GGUF:Q4_K_M` | Long-context challenger |

Repository aliases and available quant names can change. Verification at campaign
start is mandatory; a failed alias is not evidence that the base model is bad.

---

## 3. Keep results here

Runtime results may contain prompts, memory fixtures, model output, tool arguments,
file paths, and operational data. Keep them under the ignored private `var/` tree:

```text
var/benchmarks/model-tiers/<tier>gb/<model-slug>/<campaign-id>/
├── campaign.json
├── summary.csv
├── summary.json
├── decisions.md
├── run.json
├── cases.jsonl
├── transcript.jsonl
├── metrics.csv
├── local-bench.json
├── toolrepair-events.tsv
├── toolcall-failures.tsv
├── application.log
└── llamacpp.log
```

Use a UTC campaign ID such as `2026-07-14T120000Z`. Use stable lowercase model
slugs such as `qwen35-9b-q4km`; do not use a display name as a database key. Use
`8gb`, `16gb`, `24gb`, or `32gb` for the explicit target tier directory. A model
eligible for several tiers must still be run with one selected tier.

`var/` is ignored by Git and must remain private. Only a redacted, aggregate
decision table should eventually be promoted into a tracked research or planning
document. Never commit raw transcripts or logs.

`campaign.json` must record the comparison-wide controls:

```json
{
  "campaignId": "2026-07-14T120000Z",
  "gitCommit": "<commit sha>",
  "platform": "macOS",
  "hardware": "Apple M-series",
  "ramGB": 16,
  "profile": "balanced",
  "servedContext": 16384,
  "qualificationSuiteVersion": 1,
  "fixtureVersion": "<sha256 of exam.memories.json>"
}
```

Also record the tier boundary policy used by the campaign. The earlier
`install-model-tiers` plan defines exact boundaries as RAM `<= 8`, `<= 16`,
`<= 24`, and everything above 24 in the top tier. The installer implementation
must either preserve that policy or deliberately replace it with a documented
one. Never let benchmark labels, installer labels, and runtime selection use
different boundary semantics.

If the commit, prompt set, fixture, context policy, llama.cpp build, or important
configuration changes, start a new campaign. Do not append incomparable results to
an earlier campaign.

---

## 4. Prepare a fair test environment

### 4.1 Hardware

The strongest evidence comes from the actual tier hardware. Testing an 8 GB model
on a 32 GB machine does not prove it behaves safely on an 8 GB machine.

For every campaign:

1. Record OS version, CPU/GPU, total RAM, and free disk.
2. Close unrelated memory-heavy applications.
3. Keep the machine connected to power and use the same power/performance mode.
4. Disable unrelated scheduled jobs that could affect memory or throughput.
5. Allow the machine to return close to its pre-run memory and thermal baseline
   between candidates.
6. Run candidates sequentially. Concurrent model runs invalidate RAM, swap, and
   speed comparisons.

### 4.2 Shared versus isolated state

Share only the Hugging Face model cache so weights are not downloaded twice. Each
model run must otherwise use:

- a throwaway database or work directory,
- a non-default port,
- its own conversation/session,
- its own scratch directory,
- a fresh copy of the 28-memory exam fixture,
- no background agents or unrelated conversations.

The runner must stop Aperio and every llama.cpp worker it started, then remove its
throwaway state. It must never delete shared model weights or pre-existing user
data.

### 4.3 Fix comparison controls

Hold these constant within a campaign:

- Git commit
- vendored llama.cpp build
- Aperio performance profile
- served context policy
- reasoning mode
- temperature/sampling settings
- system prompt and tool schemas
- fixture data
- qualification prompts
- timeout and retry policy

Changing a setting for only one model is permitted only when the model requires a
specific response format or chat template. Record the exception in `run.json`.

### 4.4 Tool eligibility

Local models absent from `APERIO_CAPABLE_MODELS` deliberately receive no normal
tool surface. A benchmark would therefore report a meaningless total failure.

For a native-recall run, use the exact model ID in the capable list and explicitly
disable recall scaffolding:

```env
AI_PROVIDER=llamacpp
LLAMACPP_MODEL=<exact repo:quant>
APERIO_CAPABLE_MODELS=<exact repo:quant>
APERIO_RECALL_SCAFFOLD_MODELS=
APERIO_LOCAL_PERF_PROFILE=balanced
```

For scaffold-assisted comparison, repeat only the recall subset with:

```env
APERIO_RECALL_SCAFFOLD_MODELS=<exact repo:quant>
```

Do not use the scaffolded result as evidence that the model independently chose
to call `recall`. Report native and assisted recall separately.

Set `APERIO_ENABLE_SHELL=1` only for the shell and chain drills that require it.
Run in an isolated work directory and retain the normal path and shell guards.

---

## 5. Preflight every candidate

Before scoring behavior:

1. Verify the Hugging Face repository and requested quant exist.
2. Verify enough disk space exists for the model plus temporary artifacts.
3. Load the GGUF through Aperio's managed llama.cpp path.
4. Confirm the active provider reports the exact requested model.
5. Record the GGUF facts read by `ggufModelFacts`:
   - file size,
   - architecture,
   - trained maximum context,
   - KV-backed layer count,
   - KV bytes per token,
   - dense or MoE classification.
6. Confirm the served context and chat template are correct.
7. Send one harmless warm-up prompt and confirm a non-empty response.
8. Run `npm run local:bench` and preserve its structured values.
9. Reject the run as **invalid**, rather than failed, if the wrong model,
   quantization, template, context, or tool eligibility was used.

For cached models, treat the inspected GGUF as the runtime sizing authority. For
uncached recommended models, no header is available yet, so use a curated catalog
entry for the download-size and conservative context preview. Mark this
`factsSource: "catalog"` in `run.json`; after download, repeat inspection and mark
`factsSource: "gguf"`. If catalog and GGUF facts disagree materially, stop and
investigate rather than continuing with a potentially unsafe context.

Download time is not model load time. Measure and report them separately. Do not
include the initial network download in inference-performance rankings.

---

## 6. Automated runner, pilot, and campaign execution

The bounded pilot is driven by this Node.js ESM script:

```text
scripts/model-tier-bench.js
.github/model-tiers/models.json
.github/model-tiers/cases.json
```

The package command is `npm run model-tier:pilot`. It selects five cases from the
14-case catalog by default. The pilot is not itself campaign evidence.

Create a private plan from the validated catalog:

```bash
npm run model-tier:pilot -- --plan --campaign <campaign-id>
```

The current catalog produces 38 placements: 4 for 8 GB, 8 for 16 GB, 12 for
24 GB, and 14 for 32 GB. Validate the complete execution order without starting
any model process:

```bash
npm run model-tier:pilot -- --execute-campaign --dry-run --campaign <campaign-id>
```

After explicit operator approval, execute the placements sequentially through
the existing isolated pilot lifecycle:

```bash
npm run model-tier:pilot -- --execute-campaign --campaign <campaign-id>
```

Each tier's private `execution.json` records campaign controls, placement order,
and child-process outcomes. A failed placement does not prevent later placements
from running; the command exits nonzero after recording the complete ledger.

### 6.1 Runner lifecycle

For each model, the pilot runner currently does:

1. Admit the exact cached model and requested tier before starting processes.
2. Create an isolated temporary work directory and database.
3. Start Aperio on a non-default available port.
4. Reuse the standard Hugging Face cache.
5. Wait for the HTTP health check and WebSocket provider handshake.
6. Verify exact model ID, served context, and tool eligibility.
7. Import `.github/capability-exam/exam.memories.json`.
8. Wait for embeddings and verify exactly 28 `aperio-exam` memories.
9. Keep model-load metrics separate from qualification metrics; take the
   qualification baseline only after fixture and embedding readiness.
10. Run the fixed local performance benchmark.
11. Run qualification cases sequentially through the real WebSocket chat path.
12. Capture all structured events and metrics.
13. Repeat a failed case once, in a fresh conversation, to classify flaky versus
   systematic failure.
14. Export per-model results.
15. Run exam teardown and verify fixture/artifact removal.
16. Gracefully stop Aperio and its owned llama.cpp processes, including a final
   sweep of the ephemeral llama port after app shutdown.
17. Remove only the runner-created temporary state.
18. Wait for memory and thermal recovery, then continue to the next model.

Add an explicit `turn_complete` server event for the runner. `stream_end` alone is
not sufficient because provider loops may emit intermediate stream ends before a
tool executes and then continue generating.

### 6.2 Machine-readable case format

Each case needs concrete assertions rather than prose-only expectations:

```json
{
  "id": "memory-semantic-nats",
  "section": "recall",
  "prompt": "What event bus does the Nimbus service use, and why did we pick it?",
  "expectedToolSequence": ["recall"],
  "requiredAnswerTerms": ["NATS"],
  "requireAllToolsSuccessful": true,
  "hardGate": true,
  "timeoutMs": 120000
}
```

Allow alternatives only when they are behaviorally equivalent, for example
`code_search` or `code_context` as the first step. Never pass a case solely
because the final prose contains the expected word; the required tool must have
actually run.

### 6.3 Events to capture

Capture the full sequence for each turn:

- `stream_start`
- tokens/reasoning, if retained for the private transcript
- `tool_start` including tool name and arguments
- `tool_result` including success and duration
- retries and retractions
- `stream_end` including usage and llama.cpp timings
- final `turn_complete`

The transcript is diagnostic evidence. The score must be derived from structured
events and state verification, not from the model's claim that it succeeded.

---

## 7. Qualification suite

Do not run the full 65-drill exam against every model. Start with a 14-case funnel
drawn from the existing capability exam:

| Existing drill | Capability being tested | Hard gate |
|---|---|---|
| 1.2 | Semantic recall and correct answer | Yes |
| 1.3 | Recall filtered by memory type | Yes |
| 1.4 | Recall filtered by tag | Yes |
| 1.5 | Recall then update by returned ID | Yes |
| 2.1 | Recall then wiki authoring | No |
| 4.1 | Correct file-read tool selection | No |
| 4.3 | Correct, sandboxed file write | No |
| 5.4 | Write then execute a Node script | No |
| 8.1 | Recall → document → existence check | Yes |
| 8.2 | Code graph → file → syntax → run | Yes |
| 8.3 | Web fetch → source memory | Yes |
| 8.4 | Recall → wiki → provenance verification | Yes |
| 9.1 | Out-of-scope read remains blocked | Yes |
| 9.3 | Unsafe shell pipeline remains blocked | Yes |

A guardrail case passes only when the unsafe operation does not occur. A model
that refuses in prose without attempting the relevant tool demonstrates caution,
but record that separately from an exercised application guardrail.

Run all qualification prompts in the documented order because later cases depend
on fixture and artifact state. When a case is repeated, use a fresh session and
restore any state mutated by its first attempt.

---

## 8. Full exam for finalists

Only the best one or two eligible candidates per tier proceed to the full exam.
Use the existing human scorecard or the agent run-book:

- `.github/capability-exam/exam.md`
- `docs/exam/capability-exam.html`

Run all 65 scored drills once. Then repeat the four recall qualification drills
and the four multi-tool chains two additional times. This gives three observations
of the most selection-critical behavior without tripling the whole exam.

Report skill matching separately. Much of section 7 is driven by Aperio's
deterministic matcher, so it should not outweigh recall and tool-loop reliability
when selecting a model.

---

## 9. Metrics to collect

### 9.1 Behavioral scores

Store a score vector, not only one total:

```json
{
  "recall": { "passed": 4, "total": 4 },
  "toolSelection": { "passed": 4, "total": 5 },
  "chains": { "passed": 4, "total": 4 },
  "guardrails": { "passed": 2, "total": 2 }
}
```

For every case record:

- pass, fail, invalid, or skipped,
- first-attempt result,
- repeat result if applicable,
- actual tool sequence,
- expected tool sequence,
- tool result success,
- final-state assertion,
- failure classification,
- wall-clock duration.

### 9.2 Tool-call quality

`var/toolrepair/events.tsv` records schema issues such as missing required
arguments, incorrect types, unknown parameters, and empty optional parameters.

`var/toolrepair/failures.tsv` records failures that may not reach MCP: leaked
plain-text calls, corrupt tool names, prompt/schema echoes, and empty completions.
Its `persisted` field distinguishes a retry that recovered from a failure from a
failure that reached the user.

These ledgers contain only failures; they do not provide a denominator. The
runner must count every tool attempt from `tool_start` events and compute:

```text
first-attempt validity =
  (all attempts - malformed first attempts) / all attempts

persistent failure rate =
  unrecovered failures / completed benchmark cases

tool execution success =
  successful tool results / all tool results
```

At run start, record the byte offset of each shared ledger. At run end, copy only
the rows appended after that offset into the model result directory. Do not clear,
truncate, or modify the shared private logs. The extracted slice helps explain a
score: it shows whether the model was clean, repaired successfully, or remained
broken after retry.

### 9.3 Performance

Capture llama.cpp's timing block from every `stream_end` and retain:

- cold model-load overhead,
- median prompt tokens/second,
- median generation tokens/second,
- p95 completed-turn latency,
- total input and output tokens,
- total qualification duration.

Use medians for ranking; individual tool-heavy turns are noisy. Use
`npm run local:bench` for the controlled short and medium prompts, and the exam
turn timings for real-workload confirmation.

### 9.4 Context

Record:

- trained maximum context from GGUF,
- served context configured by Aperio,
- maximum input tokens observed in a case,
- any context trimming, handoff, or truncation event.

Rank based on the served and successfully exercised context, not the advertised
trained maximum.

### 9.5 RAM and swap

Poll at least once per second from baseline through teardown.

Record:

- baseline and peak system-used RAM,
- peak Aperio RSS,
- summed peak RSS of the owned llama.cpp router and worker processes,
- baseline and peak swap used,
- swap delta,
- whether the OS killed a process or llama.cpp reported an allocation error.

On macOS, read swap through `sysctl vm.swapusage`; on Linux, use `SwapTotal` and
`SwapFree` from `/proc/meminfo`. A model may start with pre-existing system swap;
the comparison signal is swap growth caused during the run.

---

## 10. Acceptance gates and ranking

A candidate is eligible to become the default only if its valid run meets all of
these gates:

- 4/4 native recall qualification cases pass.
- At least 3/4 multi-tool chains pass; prefer 4/4.
- Both qualification guardrails pass and no unsafe effect occurs.
- Zero persistent malformed or leaked tool calls.
- No model-related crash or empty completion after retry.
- Served context is at least 8,192 tokens.
- No material swap growth during the qualification run.
- Generation speed remains usable for the tier.

Define material swap before the campaign and keep it fixed. The preferred default
is zero growth. If no candidate achieves that on actual tier hardware, document
the smallest observed growth, latency impact, and resulting risk instead of
quietly relaxing the gate.

Rank eligible candidates in this order:

1. Native recall reliability
2. Multi-tool-chain reliability
3. Persistent tool-call failure count
4. First-attempt tool-call validity
5. RAM and swap headroom
6. Generation and prompt-processing speed
7. Successfully exercised context headroom
8. Download size and startup time

Do not let a high total score compensate for a failure in recall, unsafe behavior,
or persistent malformed calls.

Classify the decision for every tier as:

- **Default:** best eligible model for a clean installation.
- **Fallback:** smaller or more compatible eligible model.
- **Alternative:** detected installed model that passes compatibility and minimum
  capability checks but is not the recommended download.
- **Unsupported:** cannot use Aperio tools correctly or cannot run safely.
- **Unverified:** fits by inspection but has not completed the current campaign.

Tier membership is a separate assertion from model quality. Test the exact RAM
boundaries after the model decisions are encoded:

| Reported RAM | Expected tier |
|---:|---|
| 6 GB | 8 GB tier |
| 8 GB | 8 GB tier |
| 12 GB | 16 GB tier |
| 16 GB | 16 GB tier |
| 20 GB | 24 GB tier |
| 24 GB | 24 GB tier |
| 32 GB | 32 GB tier |
| More than 32 GB | 32 GB/top tier unless a new tier is deliberately added |

Include just-below and just-above boundary cases in automated tests so an innocent
`>=`/`>` change cannot silently move users to a model that does not fit.

---

## 11. Review the results

After all qualification runs:

1. Generate `summary.csv` and `summary.json` without starting model processes:
   `npm run model-tier:pilot -- --aggregate --tier <tier> --campaign <id>`.
2. Confirm the aggregate records one control snapshot and flags valid rows whose
   commit, hardware, context, fixture, suite, tier policy, or other comparison
   control differs.
3. Separate invalid runs from genuine model failures using `runStatus` and
   `qualificationStatus`; invalid runs are never counted as model failures.
4. Examine every persistent failure transcript and its application/llama.cpp
   logs; do not rely only on the aggregate score.
5. Identify the top two eligible candidates per tier.
6. Run the full exam for those finalists.
7. Repeat critical recall and chain cases as described in section 8.
8. Select the default and fallback using the gates and ranking order.
9. Write the rationale into `decisions.md`, including rejected finalists and the
   concrete evidence for rejection.
10. Have a human review the decisions before changing installation behavior.

Suggested `decisions.md` table:

| Tier | Default | Fallback | Native recall | Chains | Persistent failures | Peak RAM | Swap delta | Median gen tok/s | Rationale |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|
| 8 GB | ... | ... | ... | ... | ... | ... | ... | ... | ... |

If two models are close, prefer the one with cleaner first-attempt tool calls and
more RAM headroom. Installer defaults should be boring and dependable.

---

## 12. Manual workflow and remaining campaign work

The automated runner now covers preflight, the five-case funnel, and sequential
execution of every planned catalog placement. Use the manual workflow below only
for campaign review or full-exam work that the runner does not automate.

For each candidate:

1. Create a unique campaign and model result directory under
   `var/benchmarks/model-tiers/`.
2. Record the Git commit, hardware, model ID, quant, profile, and served context
   in `run.json`.
3. Configure the exact model in `.env` and put the exact same ID in
   `APERIO_CAPABLE_MODELS`.
4. Set `APERIO_RECALL_SCAFFOLD_MODELS=` for the native run.
5. Start Aperio isolated, on a non-default port, with a throwaway database.
6. Open `docs/exam/capability-exam.html` and enter the model, date, OS, and RAM.
7. Import and verify the 28-memory fixture using exam section 0.
8. Run the 14 qualification drills listed in section 7.
9. Mark individual pass/fail results and record actual tool sequences.
10. Run `npm run local:bench` and save its output values in `local-bench.json`.
11. Record timings from the WebSocket/UI where available.
12. Note baseline/peak memory and swap using Activity Monitor or the platform's
    system tools. Mark unavailable metrics as `null`; never invent them.
13. Record the start offsets of `events.tsv` and `failures.tsv`, then extract only
    newly appended rows into the result directory after the run.
14. Run exam teardown and verify that fixture memories and generated artifacts
    are gone.
15. Stop Aperio and its owned llama.cpp workers; verify no process or test state
    remains.
16. Repeat a failed drill once in a clean session.
17. Move eligible finalists to the full exam.

The browser scorecard is stored in local storage and is not a multi-model result
database. Before resetting it for the next model, copy its per-section and
per-drill outcomes into that model's `run.json` or `cases.jsonl`.

---

## 13. Turn decisions into installer behavior

After human approval, translate the evidence into one shared, versioned model
catalog. The installer, runtime recommendation, disk calculation, and Settings UI
must consume the same catalog rather than maintaining separate tier tables.

Each catalog entry should include:

```json
{
  "id": "qwen35-9b-q4km",
  "displayName": "Qwen3.5 9B",
  "hf": "unsloth/Qwen3.5-9B-GGUF:Q4_K_M",
  "quant": "Q4_K_M",
  "sizeGB": 5.3,
  "architecture": "dense",
  "minRamGB": 16,
  "tiers": [16, 24, 32],
  "status": "default",
  "toolCapable": true,
  "nativeRecall": true,
  "vision": true,
  "verifiedCampaign": "2026-07-14T120000Z"
}
```

Installer selection order should be:

1. Detect installed GGUFs in the resolved shared Hugging Face cache and approved
   model-manager directories.
2. Inspect actual GGUF facts rather than trusting filenames.
3. Match the inspected model to the verified catalog.
4. Offer an installed, eligible model that fits the machine before proposing a
   download.
5. Clearly label installed but unverified or tight-fit models.
6. If no eligible model is installed, recommend the tier default and show its
   download size and expected context.
7. Offer the tier fallback when disk space, architecture support, or user
   preference rules out the default.

Do not automatically label every discovered GGUF as tool-capable. Unknown models
may be shown as advanced/manual choices with conservative sizing, but they remain
unverified until they pass the current qualification suite.

Changing the model catalog affects behavior and installation guidance. Before
implementation, identify the required `FEATURES.md`, `CHANGELOG.md`, README, and
reference updates and obtain the user's confirmation required by the project
documentation policy.

### 13.1 Reconcile the earlier implementation plan

Before coding, update `install-model-tiers/configurable-model-tiers.md` and its
companion test file against the current repository. At minimum:

1. Mark its proposed GGUF-parser steps as superseded by
   `lib/helpers/ggufModelFacts.js` and existing tests.
2. Replace the plan's provisional July 11 defaults with the models approved by the
   completed benchmark campaign.
3. Decide whether tier overrides remain four separate config keys or become
   entries in one shared model catalog. Prefer the shared catalog as the source of
   truth; configuration should override catalog selection, not duplicate all model
   facts.
4. Decide and test the `getRecommendedModel()` return contract. The older plan
   changes it from a `MODEL_FACTS` key to a Hugging Face string, which affects
   callers. Do not change that contract accidentally.
5. Re-run a grep-driven caller audit for `getRecommendedModel`, `MODEL_FACTS`,
   `factsForHf`, and cached GGUF inspection before editing.

### 13.2 Implement verify-first

Read and update the companion tests before implementation. Establish red tests for
the approved behavior, then implement until they pass. The minimum coverage is:

| Area | Required proof |
|---|---|
| Config/catalog | Approved defaults and overrides resolve exactly |
| RAM mapping | Exact and adjacent 8/16/24/32 GB boundaries select the intended tier |
| Caller contract | Setup specs, runtime preset, progress, and budgeting accept the selected model representation |
| Cached model | Actual GGUF facts override catalog estimates |
| Uncached default | Curated facts provide safe download/context estimates |
| Unknown model | Conservative fallback is used without crashing |
| No-OOM sizing | Weight + KV + overhead stays below the shared RAM-fit budget |
| Wizard discovery | Installed eligible model is preferred over a new download |
| Unsupported discovery | Unknown GGUF is shown as unverified, never silently promoted |

The no-OOM assertion should use the same production arithmetic as runtime sizing,
not a duplicated approximation in the test:

```text
resident footprint = weights + fixed KV + growing KV + runtime overhead
resident footprint + system reserve <= total RAM
```

Pure GGUF parsing, catalog resolution, and RAM-tier mapping tests do not require a
live server. Exercise the full setup flow with an isolated process only after the
pure and integration tests are green.

### 13.3 Suggested implementation order after approval

1. Freeze the approved aggregate decisions and catalog schema.
2. Update the implementation plan and its test coverage map.
3. Add failing catalog, boundary, override, and caller-contract tests.
4. Add or update the shared model catalog.
5. Wire runtime recommendation and setup specs to that catalog.
6. Add installed-model discovery and GGUF inspection.
7. Add wizard presentation for installed/default/fallback/unverified choices.
8. Run config generation checks if `lib/config.js` changes.
9. Run focused provider, setup, cached-GGUF, and installer tests.
10. Exercise the affected setup flow in an isolated live run and clean it up.
11. Ask for approval, then update the required user-facing documentation.

The earlier plan lists likely documentation impact as `.env.example`, `README.md`,
`CHANGELOG.md`, and `id/reference/architecture.md`. Re-evaluate that list against
the actual final diff; installed-model discovery or new wizard behavior may also
require `FEATURES.md`.

---

## 14. Revalidation

Re-run affected candidates when any of these changes:

- system prompt or context assembly,
- MCP tool schemas or tool descriptions,
- tool repair/retry logic,
- recall scaffolding,
- llama.cpp build or chat-template handling,
- GGUF quantization or repository revision,
- default served-context policy,
- model release used by a tier,
- installer hardware-fit calculation.

Run a complete tier campaign periodically even without code changes, because
model repositories and available quantizations can change. Retain old aggregate
decisions for comparison, but never merge raw results from different campaign
controls into one score.

---

## 15. Completion checklist

A tier decision is complete only when:

- [ ] Exact candidate repositories and quantizations were verified.
- [ ] Runs used actual target-tier hardware or are explicitly marked provisional.
- [ ] Every candidate completed the same qualification suite.
- [ ] Invalid runs were rerun and not counted as failures.
- [ ] Native recall and scaffold-assisted recall are distinguished.
- [ ] Tool attempts, repairs, and persistent failures were counted.
- [ ] Controlled and real-workload timing metrics were recorded.
- [ ] Peak RAM, llama.cpp RSS, served context, and swap delta were recorded.
- [ ] The top finalists completed the full capability exam.
- [ ] Critical recall and chain cases were repeated three times for finalists.
- [ ] A default and fallback were selected by hard gates, not only total score.
- [ ] Raw private results remain under ignored `var/` storage.
- [ ] A human approved the decision rationale.
- [ ] The shared installer/runtime catalog is ready to consume the decision.
- [ ] Required documentation changes were identified and approved before editing.

# Model-Tier Benchmark Runner Closeout

## Current implementation and operator handoff

This section describes the implementation on branch
`feat/model-tier-benchmark-runner`. Read it before continuing the work or using
pilot output as evidence.

### 0.1 What exists now

The current branch provides:

- a final `turn_complete` WebSocket event for client chat turns, optionally
  correlated with a client-supplied `turnId`;
- model and case schemas with pure validation and scoring helpers;
- a three-case isolated pilot runner with process ownership, metric sampling,
  private artifacts, timeout classification, teardown, and cleanup;
- one exact Qwen3.5 9B Q4_K_M model entry and three pilot cases covering recall,
  a web-to-memory chain, and a guardrail;
- focused tests for the new protocol boundary, schemas, scoring, and runner
  helpers.

Validate the configuration without starting Aperio or llama.cpp:

```bash
npm run model-tier:pilot -- --validate
```

Run the current pilot for the configured exact model:

```bash
npm run model-tier:pilot -- --model qwen35-9b-q4km
```

The pilot reuses a cached model by default. Add `--allow-download` only when a
model download is intentional. Add `--note "<reason>"` to record useful operator
context with the run.

Raw results belong under `var/benchmarks/model-tiers/` and remain private. A
three-case pilot result must not be used to promote, reject, or rank a model.

### 0.2 What is not implemented yet

Before this becomes the full campaign runner described in sections 6–11, it
still needs:

- the complete 14-case qualification suite and its state fixtures;
- failed-case retry in a fresh conversation with mutated state restored;
- exact 28-memory import and embedding-readiness verification;
- tool-repair and tool-failure ledger slicing;
- campaign-wide summaries and comparable decision artifacts;
- the complete exact-model catalog and candidate preflight checks;
- finalist full-exam orchestration and tier-decision generation.

Treat each item as a separate implementation checkpoint. Explain the checkpoint,
make and verify only that bounded change, summarize discoveries, and obtain the
operator's confirmation before starting the next checkpoint.

### 0.3 What the first pilots exposed

The initial work crossed several layers. They are separated here so a future
operator can tell protocol defects, harness defects, model behavior, and test
infrastructure apart.

1. **The existing stream boundary was not a turn boundary.** `stream_end` can be
   emitted within a provider tool loop before tool execution and subsequent model
   generation continue. The runner therefore could not safely treat it as “the
   user's turn is finished.” The branch adds `turn_complete` at the outer client
   turn boundary and makes it the final event on success and error paths.
2. **The first eligibility check read the wrong handshake signal.** The greeting's
   initial tool count can be zero even when the exact model is eligible to receive
   tools later. That incorrectly invalidated a pilot whose model was already in
   `APERIO_CAPABLE_MODELS`. The handshake now reports an explicit eligibility
   signal, and the runner validates that signal instead of inferring eligibility
   from the initial tool count.
3. **Unrelated local inference invalidated performance evidence.** User-owned
   `llama-cli` jobs were already consuming resources during one pilot. They were
   not stopped or modified. The affected measurements and model outcome are not
   tier evidence.
4. **The uncontaminated behavioral observations were still insufficient.** One
   pilot passed only one of three cases: recall tools ran but the final answer
   missed required terms; the web-to-memory case did not use the required tools
   or create the required state; and the guardrail case was a model refusal rather
   than an exercised application guardrail. These observations diagnose cases and
   scoring, but they do not qualify or disqualify the model.
5. **Initial memory instrumentation saw only the router.** Metric collection was
   extended to include owned llama.cpp descendants and sum their RSS. A later
   controlled timeout captured 151 samples and roughly 23.5 GB of summed
   descendant RSS.
6. **The controlled timeout and teardown path worked.** The long pilot became an
   invalid run with a concrete timeout reason, preserved diagnostics, stopped its
   owned processes gracefully, and left no runner-created temporary, session, or
   llama state behind. This verifies failure classification and cleanup, not model
   capability.
7. **Broad lifecycle tests can collide through shared process state.** The full
   suite reached 3,012 of 3,013 passing; the isolated log-pruning test passed. A
   focused lifecycle run then leaked a real llama-server on the default test port.
   Ownership was checked before action; the test-owned PID was stopped and the
   port was verified clear. Future lifecycle verification must remain sequential
   where shared state or ports are involved and must check for owned listeners
   after completion.

Keep future status updates scoped to one of these layers:

- product protocol;
- benchmark harness;
- model behavior;
- instrumentation and cleanup;
- repository test infrastructure.

Do not combine several layers into one unexplained progress sequence.

### 0.4 Manual verification of the current branch

Run these groups independently. A failure in one group does not automatically
mean the model failed.

#### A. Verify the outer turn boundary

```bash
node --test tests/lib/emitters/handlers/wsHandler.test.js
```

Confirm the tests prove that `turn_complete`:

- is emitted once for a client chat turn;
- is the final event after any intermediate `stream_end` events;
- carries the optional request `turnId`;
- reports success and error completion distinctly.

#### B. Verify schemas and scoring without a live process

```bash
npm run model-tier:pilot -- --validate
node --test tests/lib/helpers/modelTierBench.test.js
node --test tests/scripts/model-tier-bench.test.js
```

Validation must reject duplicate IDs, invalid hard-gate definitions, unknown
model references, and malformed expected outcomes. Scoring must distinguish
`pass`, `fail`, `invalid`, and `skipped` without treating expected answer text as
proof that a required tool ran.

#### C. Exercise the isolated three-case flow

Before running, close unrelated inference work if comparable RAM/speed evidence
matters. Use a cached exact quant unless a download is deliberate:

```bash
npm run model-tier:pilot -- \
  --model qwen35-9b-q4km \
  --note "manual isolated pilot"
```

During and after the run, verify:

- the provider handshake reports the requested exact model and tool eligibility;
- every client turn ends with the matching `turn_complete`;
- `run.json`, `cases.jsonl`, `transcript.jsonl`, `metrics.csv`, and logs are stored
  only in the private campaign directory under `var/benchmarks/model-tiers/`;
- an invalid run records a concrete reason rather than becoming a model failure;
- only runner-owned processes are stopped;
- no runner-created temporary workdir, session, llama state, or listener remains.

#### D. Verify repository health separately

```bash
node --check scripts/model-tier-bench.js
git diff --check
npm test
```

If the full suite reports a failure, rerun that exact test in isolation before
classifying it. Inspect listeners and test state before stopping a process; act
only after ownership is established. Report results in three separate buckets:

1. model case failure;
2. invalid benchmark run or harness failure;
3. unrelated repository test failure.

### 0.5 Reusing the runner for future model releases

Yes—the runner is intended to be reused when new models and quants appear. For a
new candidate:

1. add a stable model ID with the exact repository and quant to
   `benchmarks/model-tiers/models.json`;
2. verify that the repository alias, quant, template, and GGUF still resolve;
3. run `npm run model-tier:pilot -- --validate`;
4. run the isolated pilot and fix harness/preflight issues before interpreting
   model behavior;
5. use a new campaign whenever the model revision, quant, llama.cpp build, prompt
   set, context policy, fixture, or important configuration changes;
6. compare models only after the full qualification runner and fixed campaign
   controls are complete.

An HTML operator page is a useful next layer for recurring monthly testing: it
could select a catalog model, launch or explain a campaign, display progress by
case, classify invalid versus failed runs, and render redacted aggregate results.
Project policy requires that new visual to be built as a standalone HTML preview,
reviewed and approved, and only then integrated under `docs/`. Do not begin that
page as an implicit continuation of runner work.

### 0.6 Prompt for a new Codex session

After clearing this session, use:

```text
Continue the model-tier benchmark work in /Users/lk/Projects/BaiGanio/aperio on
branch feat/model-tier-benchmark-runner. Read AGENTS.md,
trash/install-model-tiers/model-tier-testing-runbook.md, and
trash/install-model-tiers/model-tier-testing-closeout.md first. Inspect git
status and the existing diff; do not restart or discard completed work.

Work one bounded step at a time: explain the step and why it is next, make only
that step's changes, verify it, summarize what changed and any discoveries, then
stop and ask for my confirmation before the next step. Do not run a full campaign
or launch an HTML docs page without my explicit confirmation. Raw benchmark data
stays private under var/.

Start with: <name the single next step I approved>.
```

Replace the final placeholder with the exact next step agreed at the end of the
previous session.

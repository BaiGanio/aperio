# Next-session prompt: complete Gemma 4 E4B finalist qualification

Continue the Aperio local-model tier campaign from
`install-model-tiers/model-tier-testing-next-step.md` and the governing process
in `install-model-tiers/model-tier-testing-runbook.md`.

## Decision posture

Gemma 4 E4B UD-Q4_K_XL is the primary provisional model for all four Aperio
RAM tiers: 8, 16, 24, and 32 GB. Treat it as the sole primary candidate for
the remaining evidence work. Do not reopen broad model guessing or add another
candidate unless the required 24 GB confirmation or finalist evidence gives a
concrete reason to reject E4B.

This is a selection posture, not yet an approved installer decision. Existing
evidence shows E4B works across the tier ladder, but the lower-tier runs were
simulated on a 32 GB host and the recent full 32 GB campaign was invalid after
later chain cases timed out or exceeded context. Do not describe the model as
fully qualified until the confirmation run and finalist gates below are green.

## Candidate

- Catalog id: `gemma4-e4b-ud-q4kxl`
- Exact model: `unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL`
- Eligible tiers: 8, 16, 24, 32 GB
- Role: primary provisional model for every tier

## Immediate next step

Before the finalist exam, run one fresh, complete 14-case E4B qualification
campaign at the 24 GB target tier. Use the real 24 GB hardware if available;
otherwise record explicitly that this is simulated-tier evidence on the 32 GB
host. Run every case in the documented order, with fresh isolated state and a
new campaign id, then aggregate the results with `--aggregate`.

The command must include all 14 cases from `.github/model-tiers/cases.json`:

```bash
npm run model-tier:pilot -- \
  --model gemma4-e4b-ud-q4kxl --tier 24 \
  --campaign <fresh-24gb-campaign-id> \
  --case recall-semantic-nats \
  --case recall-filter-type \
  --case recall-filter-tag \
  --case recall-update-by-id \
  --case chain-recall-wiki \
  --case file-read-selection \
  --case file-write-sandboxed \
  --case chain-write-run-node \
  --case chain-recall-document-existence \
  --case chain-code-syntax-run \
  --case chain-web-source-memory \
  --case chain-recall-wiki-provenance \
  --case guardrail-out-of-scope-read \
  --case guardrail-unsafe-shell-pipeline

npm run model-tier:pilot -- --aggregate \
  --tier 24 --campaign <fresh-24gb-campaign-id>
```

Inspect every case result, structured tool argument, RAM/swap metric, and
teardown artifact. A timeout or explicit context overflow remains invalid
evidence and must be reported; do not silently score it as a pass or failure.

## Finalist exam and remaining work to completion

After the fresh 24 GB campaign is valid and the hard gates permit finalist
advancement:

1. Select E4B as the finalist with `--finalists` from the aggregate evidence.
2. Execute the 65-drill full capability exam once.
3. Repeat the four native recall drills and four multi-tool chain drills twice,
   for three observations of each critical behavior in total.
4. Record every drill, repetition, tool result, state assertion, context size,
   RAM/swap evidence, and any native-versus-scaffold-assisted recall split in
   the private finalist evidence record.
5. Generate private `decisions.json` and `decisions.md` with `--decide` only
   after the complete finalist evidence validates.
6. Review the decision rationale with a human. It must name Gemma 4 E4B as the
   proposed default for 8/16/24/32 GB, state the 32 GB-host simulation caveat
   for lower tiers, and document fallback/alternative/rejection fields as
   required by the decision schema.
7. Only after human approval, update installer/runtime/catalog wiring and the
   associated user-facing documentation. Do not perform that integration in
   this session.

## Hard gates

- 4/4 native recall cases pass.
- At least 3/4 multi-tool chains pass; prefer 4/4.
- Both guardrails pass with no unsafe effect.
- Zero persistent malformed, leaked, or failed tool calls.
- Served context is at least 8,192 tokens.
- No material qualification swap growth.
- No model crash or empty completion after retry.
- All 14 cases complete validly; every timeout/context overflow is rerun and
  explained before scoring.
- Full-exam evidence contains all 65 drills plus all required repeats, with no
  duplicate, missing, or unexpected observations.

## Constraints

- Keep raw artifacts under ignored `var/benchmarks/model-tiers/` only.
- Keep the fixed 300-second case deadline unchanged.
- Do not add Gemma 4 12B or reopen broad catalog comparisons.
- Do not change installer defaults, tier policy, runtime wiring, or catalog
  roles before human approval of the private decision.
- Read existing logs and the current git diff before starting processes.
- Preserve concurrent edits and never modify prior private runs.
- Verify teardown leaves no runner-owned process, listener, or temporary
  workdir.

## Completion condition

The work is complete only when the 24 GB confirmation is valid, E4B has a
validated finalist full-exam record with the required repeats, private tier
decision artifacts exist, and a human has reviewed the proposed all-tier
default. Until then, call E4B the primary provisional model for all tiers—not
the approved installer default.

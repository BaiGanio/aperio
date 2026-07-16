# Next-session prompt: qualify Gemma 4 E4B for tier decisions

Continue the Aperio local-model tier campaign from the checkpoint in
`install-model-tiers/model-tier-testing-next-step.md` and the governing process
in `install-model-tiers/model-tier-testing-runbook.md`.

## Objective

Turn Gemma 4 E4B UD-Q4_K_XL from the preferred provisional candidate into an
evidence-backed tier decision—or reject it—with the 14-case qualification suite,
required RAM/swap/tool-quality evidence, finalist full exam, and explicit
real-hardware caveats. Do not change installer behavior or tier policy until
human approval.

## Candidate

- Catalog id: `gemma4-e4b-ud-q4kxl`
- Exact model: `unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL`
- Eligible tiers: 8, 16, 24, 32 GB
- Current role: `provisional-default`

## Evidence already captured

- Fresh 32 GB hardware-tier `chain-recall-wiki`: PASS, 201.5s,
  `statePassed: true`, 3 successful tool results, zero persistent tool
  failures, zero qualification swap growth.
- Earlier 8/16/24 GB chain verifications passed, but are simulated-tier
  evidence on a 32 GB host and must remain provisional.
- A later five-case 32 GB funnel became invalid when `chain-recall-wiki`
  reached the fixed 300-second deadline. Preserve it as invalid evidence and
  rerun the case cleanly; do not score the timeout as a model failure.

## Required work

1. Read the runbook, current git diff, and existing private artifacts before
   starting processes. Preserve concurrent edits and never modify prior runs.
2. Run the focused contract tests, including wiki-handler, provider/context,
   MCP profile, and model-tier runner tests. The source-id schema/handler fix
   must remain green.
3. Re-run E4B `chain-recall-wiki` once in a fresh 32 GB campaign. Inspect the
   structured tool arguments and confirm the malformed-source path reaches the
   handler rather than failing MCP validation.
4. Run the full 14-case qualification suite for E4B at 32 GB, then repeat at
   24, 16, and 8 GB only when the preceding result is valid and the hardware or
   provisional exception is explicitly recorded. Use fresh campaign IDs and
   sequential isolated runs.
5. Aggregate private results with `--aggregate`. Separate invalid runs from
   genuine failures and keep native recall distinct from scaffold-assisted
   recall.
6. If hard gates permit, select at most two finalists with `--finalists` and
   execute the 65-drill full exam plus the required recall/chain repeats.
7. Generate private `decisions.json` and `decisions.md` with `--decide` only
   after complete finalist evidence exists. The decision must state default,
   fallback, alternatives, rejection rationale, and simulated-tier caveats.
8. Stop before installer/runtime/catalog wiring. Ask for approval after the
   evidence and decision rationale are reviewable.

## Hard gates

- 4/4 native recall cases pass.
- At least 3/4 multi-tool chains pass; prefer 4/4.
- Both guardrails pass with no unsafe effect.
- Zero persistent malformed/leaked tool calls.
- Served context is at least 8,192 tokens.
- No material qualification swap growth.
- No model crash or empty completion after retry.
- Every timeout remains invalid evidence until cleanly rerun.

## Constraints

- Keep raw artifacts under ignored `var/benchmarks/model-tiers/` only.
- Keep the fixed 300-second case deadline unchanged.
- Do not add Gemma 4 12B to the catalog; its scratch 16 GB run timed out on
  `recall-filter-tag` and did not beat E4B evidence.
- Do not edit installer defaults, model catalog policy, or further user-facing
  docs until the evidence is complete and human approval is obtained.
- Inspect logs before reruns and verify teardown leaves no runner-owned process,
  listener, or temporary workdir.

## Completion condition

The stage is complete only when E4B has a valid qualification result for each
claimed tier, a finalist exam record with required repeats, and a human-reviewed
private decision. Until then, describe E4B as the preferred provisional
candidate, not the approved installer default.

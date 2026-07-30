# Ponytail-borrow WS2 — Live Eval Handoff

After rebooting, run these commands in order to get a definitive verdict on `skills/code-minimalism`.

## 1. Quick smoke test — verify the model loads

```bash
# Clear old ledger from previous runs
rm -f var/autotune/minimalism.tsv var/autotune/minimalism.report.md
rm -rf var/autotune/transcripts

# Start isolated server. Do NOT hardcode LLAMACPP_SERVE_CTX/LLAMACPP_CTX — leave
# them unset and let ensureLlamaCpp() auto-size from the model's real GGUF facts
# (lib/helpers/llamacpp/sizing.js): balanced profile caps at a 131072 ceiling
# regardless of RAM headroom; long-context raises the ceiling to 262144 and
# computes the model's true fit. On a 32GB machine with a ~9B model this fits
# comfortably (weights + full KV cache well under half of RAM) — verify per-model
# with `factsFromGguf()`/`recommendContextLength()` before assuming a number,
# rather than copying a context value from a different model's run.
cd ~/Projects/BaiGanio/aperio
LLAMACPP_PORT=18080 APERIO_LOCAL_PERF_PROFILE=long-context \
  node scripts/minimalism-live-server.js
```

Wait for `✅ llama-server ready`. Then in another terminal:

```bash
# Smoke test: one fixture, 1 repeat, check tokens are non-zero
cd ~/Projects/BaiGanio/aperio
node scripts/minimalism-bench.js \
  --model="protoLabsAI/Ornith-1.0-9B-MTP-GGUF:Q4_K_M" \
  --tasks=debounce-stdlib \
  --repeats=1 \
  --existing-server
```

If this prints a cell with `tokens=...` (not zeroes), the setup works.

## 2. Sanity-tier floor check — gate before spending on the feature tier

Per `ponytail-borrow-ws2-feature-tier.md`: a model that can't reliably write a
syntactically valid 10-line file has no business being the subject of the pricier
feature-tier matrix. Run the 6 sanity fixtures first and check correctness clears
the floor before running `cache-entry-ttl`.

```bash
cd ~/Projects/BaiGanio/aperio
node scripts/minimalism-bench.js \
  --model="protoLabsAI/Ornith-1.0-9B-MTP-GGUF:Q4_K_M" \
  --tasks=debounce-stdlib,divide-with-validation,includes-wrapper,\
parse-config-value,reuse-query-parser,slug-helper \
  --repeats=3 \
  --existing-server \
  --verdict
```

If correctness clears the floor, proceed to the feature tier below. If it doesn't,
escalate the model (`Qwen3.5-4B`, then `gemma-4-12B`) and re-run this floor check
before touching the feature tier at all — that's the epic's own INCONCLUSIVE/stop
discipline, not optional.

## 3. Feature-tier run — definitive verdict (only after the floor check clears)

```bash
# The over-engineering-room fixture, 3 repeats (3 recorded cells + 1 warmup)
cd ~/Projects/BaiGanio/aperio
node scripts/minimalism-bench.js \
  --model="protoLabsAI/Ornith-1.0-9B-MTP-GGUF:Q4_K_M" \
  --tasks=cache-entry-ttl \
  --repeats=3 \
  --existing-server \
  --verdict
```

The `--verdict` flag prints `KEEP`/`TRIM`/`DROP`/`INCONCLUSIVE` at the end. Sanity
and feature tiers are separate verdicts — `computeVerdict()` runs once per tier via
`--tasks=`, never pooled, since a pooled median would blend two different questions
into one number.

## 4. Review results

```bash
cat var/autotune/minimalism.report.md
cat var/autotune/minimalism.tsv
ls var/autotune/transcripts/minimalism/
```

## What the verdict means

| Verdict | Meaning | Action |
|---|---|---|
| **KEEP** | ≥15% fewer LOC, net tokens ≤ 0, no correctness regression | Ship it — the skill pays for itself |
| **TRIM** | ≥15% fewer LOC but net tokens positive (skill costs tokens) | Keep but shorter. Trim ~500 tokens from the SKILL.md |
| **DROP** | No LOC win or any correctness regression | Remove the skill — it hurts more than helps |
| **INCONCLUSIVE** | Effect smaller than repeat-to-repeat noise | More repeats needed, or a different model |

## Background context (read first)

The WS2 eval compares arm A (`skills/` includes `code-minimalism`) vs arm B (same sandbox minus that one skill directory). Each fixture seeds a workspace, the model reads and edits files, and a `node --test` suite judges correctness. LOC, token counts, and wall time are recorded per cell.

The 7 fixtures are:
- **debounce-stdlib** — "Write a debounce helper" (stdlib rung 3 test)
- **divide-with-validation** — "Write divide with error handling" (non-negotiables test)
- **includes-wrapper** — "Check if includes() already exists" (rung 2, write nothing)
- **parse-config-value** — "Parse config from string" (validation required)
- **reuse-query-parser** — "Reuse existing query parser" (rung 2, reuse not rewrite)
- **slug-helper** — "Write URL slug helper" (simple helper)
- **cache-entry-ttl** — "Add TTL expiry to existing store" (feature-tier, over-engineering trap)

Previous DeepSeek-v4-flash run (3 repeats) showed directional signal — `debounce-stdlib` arm A scored 2/3 correct with 45% less LOC vs arm B's 1/3 correct — but verdict was INCONCLUSIVE due to high inter-repeat variance with a non-code model. The 14B coder should tighten variance and yield a clean verdict.

## If something goes wrong

- **"Compute error" / zero tokens**: Metal GPU state corrupted. Kill all llama-server processes (Activity Monitor → search `llama-server` → force quit each), then restart the server.
- **"Port already in use"**: `lsof -ti :18080 | xargs kill -9`, wait 3s, retry.
- **Stuck cell (>5 min)**: Ctrl+C, restart from step 2. The ledger will append new rows alongside any already written.

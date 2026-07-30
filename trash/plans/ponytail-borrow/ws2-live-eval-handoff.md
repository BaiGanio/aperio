# Ponytail-borrow WS2 — Live Eval Handoff

After rebooting, run these commands in order to get a definitive verdict on `skills/code-minimalism`.

## 1. Quick smoke test — verify the model loads

```bash
# Clear old ledger from previous runs
rm -f var/autotune/minimalism.tsv var/autotune/minimalism.report.md
rm -rf var/autotune/transcripts

# Start isolated server with 8K context (avoids Metal OOM on 78K ctx)
cd ~/Projects/BaiGanio/aperio
LLAMACPP_PORT=18080 LLAMACPP_SERVE_CTX=8192 LLAMACPP_CTX=8192 \
  node scripts/minimalism-live-server.js
```

Wait for `✅ llama-server ready`. Then in another terminal:

```bash
# Smoke test: one fixture, 1 repeat, check tokens are non-zero
cd ~/Projects/BaiGanio/aperio
node scripts/minimalism-bench.js \
  --model="unsloth/Qwen2.5-Coder-14B-Instruct-128K-GGUF:Q4_K_M" \
  --tasks=debounce-stdlib \
  --repeats=1 \
  --existing-server
```

If this prints a cell with `tokens=...` (not zeroes), the setup works.

## 2. Full run — definitive verdict

```bash
# All 7 fixtures, 3 repeats (42 recorded cells + 7 warmups)
cd ~/Projects/BaiGanio/aperio
node scripts/minimalism-bench.js \
  --model="unsloth/Qwen2.5-Coder-14B-Instruct-128K-GGUF:Q4_K_M" \
  --tasks=debounce-stdlib,divide-with-validation,includes-wrapper,\
parse-config-value,reuse-query-parser,slug-helper,cache-entry-ttl \
  --repeats=3 \
  --existing-server \
  --verdict
```

Expected time: ~30-45 minutes (49 cells × ~40s avg on 14B Q4_K_M).

The `--verdict` flag prints `KEEP`/`TRIM`/`DROP`/`INCONCLUSIVE` at the end.

## 3. Review results

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

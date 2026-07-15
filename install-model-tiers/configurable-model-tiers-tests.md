# Tests: Configurable RAM-tier models (+ GGUF-derived sizing)

## Coverage map
| Plan step | Test group | Coverage |
|-----------|-----------|----------|
| 1 | Config registry | 4 tier keys exist, defaults, gen:env:check |
| 2 | getRecommendedModel | RAM→tier→hf string, env override, unset=default |
| 3 | Caller wiring | callers handle hf string, no MODEL_FACTS[key] crash |
| 4 | GGUF parser | header fields extracted, degrades on missing |
| 5 | resolveModelFacts | disk→derive, else catalog, else generic |
| 6 | serveCtxFor | sizes from GGUF; Ornith fits 32GB w/o table entry |
| 7 | MODEL_FACTS shrink | catalog-only; all suites green |

## Test cases

### G1 — config registry (step 1)
- **Setup:** load `lib/config.js` CONFIG.
- **Assert:** keys `LLAMACPP_MODEL_TIER_{8,16,24,32}` present, section `llamacpp`,
  non-empty defaults; `npm run gen:env:check` exits 0.

### G2 — getRecommendedModel tiers (step 2)
- **Setup:** call with `{ totalRamGB }` at 6, 12, 20, 40 and empty env, then with each
  `LLAMACPP_MODEL_TIER_*` overridden.
- **Expected:** 6→tier_8, 12→tier_16, 20→tier_24, 40→tier_32. Returns the hf **string**.
- **Assert:** unset → the curated defaults decided 2026-07-11
  (see plan step 1 table / `trash/model-tiers-research.md`):
  8→`unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL`, 16→`unsloth/Qwen3.5-9B-GGUF:Q4_K_M`,
  24→`unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_XL`,
  32→`unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL`; override → the override string.
  **Edge:** RAM exactly 8/16/24 → lands in the lower tier (≤ boundary); RAM > 32 →
  tier_32.

### G3 — caller wiring (step 3)
- **Setup:** grep-driven list — `startLlamaCpp.js:81/90`, `specs.js:24`,
  `roundtableBudget.js:29`, `modelProgress.js:87`.
- **Assert:** with a tier set to a non-catalog hf, `buildModelsPreset` and `specs`
  don't throw / don't read `undefined.hf`.

### G4 — GGUF parser (step 4)
- **Setup:** point at the cached Ornith GGUF (`~/.cache/huggingface/hub/
  models--deepreinforce-ai--Ornith-1.0-9B-GGUF/snapshots/*/…gguf`).
- **Expected:** returns `{ architecture, blockCount, headCountKv, embeddingLength,
  contextLength, expertCount }`.
- **Assert:** `estimateKvBytesPerToken(parsed)` ≈ 5.24e5 (±10%); contextLength > 0.
  **Edge:** truncated/for-arch-missing field → returns null, no throw; non-existent
  path → null.

### G5 — resolveModelFacts precedence (step 5)
- **Assert:** (a) cached non-catalog model → facts from GGUF (kvBytesPerToken from
  file, not 524288 generic); (b) not cached but in catalog → catalog facts;
  (c) neither → generic `{sizeGB:8, kvBytesPerToken:524288}`.

### G6 — serveCtxFor no-OOM (step 6, the regression guard)
- **Setup:** `LLAMACPP_MODEL=deepreinforce-ai/Ornith-1.0-9B-GGUF` (cached), 32 GB,
  **Ornith removed from MODEL_FACTS**.
- **Expected:** ctx-size ≈ 25600 (KV ≈ 12–13 GB, +5.3 GB weights < 32 GB).
- **Assert:** `ctx * kvBytesPerToken / 1e9 + sizeGB < totalRamGB - breathing`.
  This is the OOM regression test — the whole point.

### G7 — MODEL_FACTS shrink (step 7)
- **Assert:** MODEL_FACTS keys ⊆ the 4 curated tier defaults (`gemma4:e4b-qat`,
  `qwen3.5:9b`, `gemma4:26b-a4b`, `qwen3.6:35b-a3b-mtp`) + VLM; the two MoE entries
  have `architecture: "moe"` + `activeParams`; existing
  `providers.test.js` invariants (hf regex, dense|moe, activeParams-only-on-MoE) hold;
  full `npm test` shows no new failures (baseline: 19 pre-existing env failures —
  keychain/network/DB — unrelated).

## Execution order
G1 → G2 → G3 (Part A, independent of GGUF). G4 → G5 → G6 → G7 (Part B; G6 depends on
G4+G5). G6 is the acceptance gate for the whole plan.

## Required setup
- A cached GGUF to parse (Ornith already in `~/.cache/huggingface/hub`).
- No live server needed — parser reads the file header; sizing is pure. Follow the
  Co-pilot Contract: do not spawn llama-server to verify.

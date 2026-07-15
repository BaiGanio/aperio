#  — 

**Date:** 2026-07-11
**Goal:** Recommend one default llama.cpp model per RAM tier (8 / 16 / 24 / 32 GB) plus
diverse alternatives to test, so Aperio doesn't ship restricted to the maintainer's
comfort set (gemma-4-E4B-qat, Qwen3.6-35B-A3B-MTP, Qwen3.5-9B).

**Selection criterion:** MCP tool-call reliability under Aperio's full system prompt +
tool schema — not chat quality. Compare candidates with the tool-repair harness
(`var/toolrepair/events.tsv`).

## Memory budget rule of thumb (Apple Silicon / unified memory)

The GPU can realistically use ~2/3–3/4 of unified memory; the rest goes to OS + app +
KV cache headroom.

| Machine RAM | Model file budget (model + KV) |
|-------------|-------------------------------|
| 8 GB        | ~4–5 GiB                      |
| 16 GB       | ~10–11 GiB                    |
| 24 GB       | ~16–17 GiB                    |
| 32 GB       | ~22–24 GiB                    |

## Verified GGUF sizes (Hugging Face API, spot-checked 2026-07-11)

| Repo | File | Size |
|------|------|------|
| `unsloth/Qwen3.5-4B-GGUF` | UD-Q4_K_XL | 2.7 GiB |
| `unsloth/Qwen3.5-9B-GGUF` | UD-Q4_K_XL | 5.6 GiB |
| `unsloth/Qwen3.6-27B-GGUF` | UD-Q4_K_XL | 16.4 GiB |
| `unsloth/Qwen3.6-35B-A3B-MTP-GGUF` | UD-Q4_K_XL | 21.3 GiB |
| `ggml-org/gpt-oss-20b-GGUF` | mxfp4 | 11.3 GiB |
| `unsloth/gemma-4-E2B-it-GGUF` | UD-Q4_K_XL | 3.0 GiB |
| `unsloth/gemma-4-E4B-it-qat-GGUF` | UD-Q4_K_XL | 3.9 GiB |
| `unsloth/gemma-4-26B-A4B-it-GGUF` | UD-Q4_K_XL | 15.8 GiB |
| `unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF` | UD-Q4_K_XL | 13.5 GiB |
| `unsloth/Phi-4-mini-instruct-GGUF` | Q4_K_M | 2.3 GiB |
| `ggml-org/SmolLM3-3B-GGUF` | Q4_K_M | 1.8 GiB |
| `unsloth/granite-4.1-8b-GGUF` | UD-Q4_K_XL | 5.1 GiB |
| `unsloth/granite-4.1-30b-GGUF` | UD-Q4_K_XL | 16.5 GiB |
| `unsloth/granite-4.0-h-small-GGUF` | UD-Q4_K_XL | 17.5 GiB |
| `unsloth/granite-4.0-h-tiny-GGUF` (7B-A1B MoE) | UD-Q4_K_XL | 3.8 GiB |
| `unsloth/LFM2-8B-A1B-GGUF` (MoE) | UD-Q4_K_XL | 4.4 GiB |
| `unsloth/Qwen3.5-2B-GGUF` | UD-Q4_K_XL | 1.2 GiB |

Note: "Mistral Small 4" (`unsloth/Mistral-Small-4-119B-2603-GGUF`) is 119B — NOT a
local-tier model. The local-sized Mistral remains Small 3.2-24B (2506).

## Tier defaults — DECIDED 2026-07-11

These are the curated defaults for the configurable-tiers plan
(`trash/plans/install-model-tiers/configurable-model-tiers.md`, step 1).

| Tier | Default | Size | Rationale |
|------|---------|------|-----------|
| 8 GB | `unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL` | 3.9 GiB | Already the code's 8 GB pick (`gemma4:e4b`); QAT holds quality. Runtime sizing now reads the cached GGUF instead of comparing hand-maintained KV estimates. |
| 16 GB | `unsloth/Qwen3.5-9B-GGUF:Q4_K_M` | 5.3 GiB | Strong native tool calling; hybrid attention keeps measured F16 KV cost to 32 KiB/token (8 KV-backed layers), not the earlier 524 KiB estimate. |
| 24 GB | `unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_XL` | 15.8 GiB | MoE, 4B active — near-dense-27B quality at small-model speed; benefits from `--n-cpu-moe` |
| 32 GB | `unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL` | 21.3 GiB | Strongest open agentic model that fits; MoE + MTP speculative speedup |

MoE note: the app's `--n-cpu-moe` offload optimization only engages on the 24/32 GB
tiers — E4B and Qwen3.5-9B are dense. That's acceptable (offload matters most when
total size ≫ budget). If MoE-everywhere is ever wanted: granite-4.0-h-tiny (7B-A1B,
3.8 GiB) and LFM2-8B-A1B (4.4 GiB) are the only true small MoEs; gpt-oss-20b
(11.3 GiB) is the 16 GB MoE.

## Alternatives to test per tier (diversity)

### 8 GB (budget ~4–5 GiB) — default: gemma-4-E4B-it-qat
- `unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL` — 2.7 GiB. First alternative: native tool-call
  tokens (Gemma uses prompted JSON), smaller file → more headroom. Its exact KV
  cost should be read from the downloaded GGUF; let the exam harness arbitrate.
- `unsloth/granite-4.0-h-tiny-GGUF:UD-Q4_K_XL` — 3.8 GiB. 7B-A1B **hybrid MoE** —
  the only tier-8 model that engages the `--n-cpu-moe` path; tool-call-tuned,
  Apache-2.0, tiny KV (Mamba). Test candidate.
- `unsloth/LFM2-8B-A1B-GGUF:UD-Q4_K_XL` — 4.4 GiB. Liquid AI **MoE**, edge-tuned.
- `unsloth/Phi-4-mini-instruct-GGUF:Q4_K_M` — 2.3 GiB. MIT license, strong reasoning
  for size; weaker multilingual than Qwen.
- `ggml-org/SmolLM3-3B-GGUF:Q4_K_M` — 1.8 GiB. Fully open (HF), dual-mode reasoning,
  native JSON/XML tool calling, 64K context. Floor-tier option.
- `unsloth/gemma-4-E2B-it-GGUF:UD-Q4_K_XL` — 3.0 GiB. Multimodal; tool calls on ~3 GiB.

### 16 GB (budget ~10–11 GiB) — default: Qwen3.5-9B
- `ggml-org/gpt-oss-20b-GGUF` (mxfp4) — 11.3 GiB. The 16 GB **MoE** (3.6B active):
  excellent function calling, different lineage (OpenAI, Apache-2.0); tight fit —
  needs Gerganov's `--n-cpu-moe 12 -fa --no-mmap` recipe. Harmony format via `--jinja`.
- `unsloth/granite-4.1-8b-GGUF:UD-Q4_K_XL` — 5.1 GiB. IBM, Apache-2.0, hybrid Mamba →
  unusually low KV-cache memory at long context; explicitly tuned for tool calling.
  Interesting for Aperio's long-context memory workloads.

### 24 GB (budget ~16–17 GiB)
- `unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF:UD-Q4_K_XL` — 13.5 GiB. Dedicated
  function-calling tokens, very reliable structured output; comfortable fit.
- `unsloth/Qwen3.6-27B-GGUF:UD-Q4_K_XL` — 16.4 GiB. Dense; max per-token quality but
  borderline on budget — prefer Q4_K_M (15.7 GiB) here.
- `unsloth/granite-4.1-30b-GGUF:UD-Q4_K_XL` — 16.5 GiB. Borderline; hybrid arch keeps
  KV small, so long context may fit where transformers wouldn't.
- gpt-oss-20b — 11.3 GiB, very comfortable here with full context.

### 32 GB (budget ~22–24 GiB)
- `unsloth/Qwen3.6-27B-GGUF:UD-Q4_K_XL` — 16.4 GiB. Dense alternative to the 35B MoE:
  higher per-token quality, slower.
- `unsloth/granite-4.0-h-small-GGUF:UD-Q4_K_XL` — 17.5 GiB (32B-A9B hybrid MoE).
- `unsloth/gemma-4-26B-A4B-it-GGUF` — 15.8 GiB with huge context headroom.

## Testing notes

1. **Tool-JSON well-formedness** under the full Aperio prompt + schema is the gate.
   Run the exam harness (`exam.md`) drills per candidate and compare
   `var/toolrepair/events.tsv` mismatch rates.
2. **MoE degrades more gracefully on Macs**: experts can be pushed to CPU with
   `--n-cpu-moe N` when a tier is tight. Dense models can't. For the 8 and 16 GB
   tiers prefer small-dense or MoE-with-offload.
3. **Watch the weak-model recall failure mode** (QWEN3 treating the 5-row preload as
   exhaustive): verify each 8 GB-tier candidate actually invokes `recall` under the
   preview-framing prompt.
4. Sizes above are file sizes only — add KV cache (context-length dependent) before
   declaring a fit. Hybrid-Mamba (Granite) and MoE models have different KV profiles.

## Runtime sizing — implemented 2026-07-12

`lib/helpers/ggufModelFacts.js` now inspects the selected cached GGUF before Aperio
generates llama.cpp's router preset. It derives actual file size, trained context,
KV-backed layer count (including hybrid `full_attention_interval`), KV heads,
key/value dimensions, and dense/MoE architecture. `MODEL_FACTS` remains useful for
pre-download recommendations, but it is no longer the authority for a cached model.

Measured locally from the selected files:

| Model | GGUF size | KV-backed layers | F16 KV bytes/token |
|-------|-----------|------------------|--------------------|
| Qwen3.5 9B Q4_K_M | 5.29 GiB | 8 | 32,768 |
| Qwen3.6 35B-A3B MTP Q4_K_XL | 21.28 GiB | 11 (41 blocks, interval 4) | 22,528 |

Unknown but cached models use the same inspection path automatically. An uncached or
unreadable model uses the conservative fallback for its first managed load and logs
that fact explicitly; after the GGUF exists locally, the next managed restart uses
measured sizing. Explicit `LLAMACPP_SERVE_CTX` remains the final override.

## Sources

- [Best local LLMs per Apple Silicon Mac (apxml)](https://apxml.com/posts/best-local-llm-apple-silicon-mac)
- [Local LLMs on Apple Silicon 2026 (SitePoint)](https://www.sitepoint.com/local-llms-apple-silicon-mac-2026/)
- [Qwen3.6 — Unsloth docs](https://unsloth.ai/docs/models/qwen3.6) · [Qwen3.5 — Unsloth docs](https://unsloth.ai/docs/models/qwen3.5)
- [Gemma 4 — Unsloth docs](https://unsloth.ai/docs/models/gemma-4)
- [gpt-oss-20b on a 16 GB Mac (Gerganov)](https://x.com/ggerganov/status/1961136036097991000) · [gpt-oss with llama.cpp guide](https://github.com/ggml-org/llama.cpp/discussions/15396)
- [5 small LMs for agentic tool calling (KDnuggets)](https://www.kdnuggets.com/5-small-language-models-for-agentic-tool-calling)
- [Best open-source LLMs for agentic coding 2026 (MindStudio)](https://www.mindstudio.ai/blog/best-open-source-llms-agentic-coding-2026)
- File sizes: Hugging Face API (`/api/models/<repo>?blobs=true`), fetched 2026-07-11

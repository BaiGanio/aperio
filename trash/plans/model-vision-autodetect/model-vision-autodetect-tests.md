# Tests — Auto-detect model vision

Companion to `model-vision-autodetect.md`. Verify-first: every criterion below must be
red before implementation and green after.

## Coverage map

| Plan step | Test group | Coverage |
|-----------|-----------|----------|
| WS1 | G1 — `hasCachedMmproj` fixture scan | mmproj present / absent / no snapshot / bad refs |
| WS1 | G2 — chat-template tool probe | GGUF `tokenizer.chat_template` → `tools` boolean; string not retained |
| WS1 | G3 — `modelCapabilities()` resolution order | provider map → cache → hub → unknown; memoisation |
| WS1 | G4 — real-cache oracle | all 11 cached repos on this machine, 11/11 |
| WS2 | G5 — lists are gone | grep gate + no dangling imports |
| WS2 | G6 — rewired call sites | agent/index, llamacpp provider, preset, vlm, image tool |
| WS3 | G7 — preset shape | one entry for a sighted main model, two for a blind one |
| WS4 | G8 — `ensureVisionEngine` | no-op when up; vision-only preset when down; failure path |
| WS5 | G9 — generators + docs | `gen:env:check`, no stale key references |

## Test cases

### G1 — `hasCachedMmproj(model, cacheRoot)`

Fixtures build fake HF cache trees under the scratch dir:
`models--<org>--<repo>/refs/main` → `<rev>`, `models--<org>--<repo>/snapshots/<rev>/…`.

| Name | Setup | Expected |
|---|---|---|
| G1.1 finds mmproj | snapshot holds `model-Q4_K_M.gguf` + `mmproj-BF16.gguf` | returns the absolute mmproj path |
| G1.2 no mmproj | snapshot holds only `model-Q4_K_M.gguf` | returns `null` |
| G1.3 case-insensitive | file named `MMPROJ-F16.GGUF` | returns the path |
| G1.4 not cached | no `models--…` dir at all | returns `null`, no throw |
| G1.5 broken refs | `refs/main` missing | returns `null`, no throw |
| G1.6 bare .gguf path | `model` is an absolute `.gguf` path | scans its own directory |

Edge: a repo id with no `/` (an alias, not a repo) must return `null` without touching disk.

### G2 — tool support from the chat template

| Name | Setup | Expected |
|---|---|---|
| G2.1 tool-calling template | GGUF whose `tokenizer.chat_template` contains `tools` | `tools: true` |
| G2.2 llava template | a real llava template string (no `tools`, no `tool_call`) | `tools: false` |
| G2.3 no template key | GGUF with the key absent | `tools: true` (permissive default — never withhold tools on missing data) |
| G2.4 string not retained | after any call | the cached facts object has no `chat_template` / `tokenizer.chat_template` key, and holds no string over 4 KB |

Edge: a 50 KB template must not appear in a `JSON.stringify` of the cache entry.

### G3 — `modelCapabilities(model, env)` resolution order

| Name | Setup | Expected |
|---|---|---|
| G3.1 cloud provider wins | `modelCapabilities("claude-opus-5", env, {provider:"anthropic"})` | `{vision:true, source:"provider"}`, no disk access |
| G3.2 deepseek is blind | provider `deepseek`, any model incl. `deepseek-v4-pro` | `{vision:false, source:"provider"}` |
| G3.3 cache beats hub | model cached with mmproj | `source:"cache"`, `fetch` never called |
| G3.4 hub fallback | model not cached, stubbed `fetch` returns a tree with `mmproj-BF16.gguf` | `{vision:true, source:"hub"}` |
| G3.5 hub failure is safe | `fetch` rejects / times out | `{vision:false, source:"unknown"}`, no throw |
| G3.6 memoised | two calls, same key | disk/`fetch` touched once |
| G3.7 cache key includes root | same model, two different `cacheRoot`s | two independent answers |

Edge: `modelCapabilities(undefined)` and `("")` return a safe blind result rather than throwing.

### G4 — real-cache oracle (integration, skipped when the cache is absent)

Iterate `~/.cache/huggingface/hub/models--*` and assert `modelCapabilities().vision`
matches an mmproj-on-disk ground truth computed independently in the test. Must be
11/11 on this machine, and must specifically get `unsloth/Qwen3.6-35B-A3B-MTP-GGUF`
right — the case the deleted regex got wrong.

### G5 — the lists are gone

`grep -rn` over `lib/ mcp/ db/ public/` for each of: `isVisionModel`, `isToollessVLM`,
`isCapableModel`, `needsRecallScaffold`, `APERIO_CAPABLE_MODELS`,
`APERIO_RECALL_SCAFFOLD_MODELS`, `LLAMACPP_VLM_MODEL`, `LLAMACPP_VLM_MMPROJ`,
`IMAGE_DROPPING_PROVIDERS`, `providerDropsImages` → zero hits.
Node must import every touched module without an unresolved-export error.

### G6 — rewired call sites

| Name | Expected |
|---|---|
| G6.1 | `lib/agent/index.js` sets `modelHandlesInlineImage` purely from `modelCapabilities().vision` |
| G6.2 | every model receives a non-empty tool set — the old "non-capable ⇒ `[]`" branch is gone |
| G6.3 | `llamacpp` provider sets `state.noTools` from `!modelCapabilities().tools`, not a name |
| G6.4 | a blind local main model still routes raw images through the bridge and never sees pixels |
| G6.5 | a sighted local main model receives raw pixels and makes no `describe_image` call |

### G7 — preset shape

| Name | Setup | Expected |
|---|---|---|
| G7.1 sighted default | `LLAMACPP_MODEL` unset | exactly one section besides `[*]`; no `aperio-vlm` |
| G7.2 blind main | `LLAMACPP_MODEL=protoLabsAI/Ornith-1.0-9B-MTP-GGUF` | two sections; `aperio-vlm` hf-repo is `defaultLocalModel()`; its `ctx-size` ≤ 24576 |
| G7.3 mmproj once | as G7.2 | `mmproj =` appears exactly once, inside the `aperio-vlm` section only |
| G7.4 swap mode | tiny `hardware.totalRamGB` | `models-max = 1` present |

### G8 — `ensureVisionEngine()`

| Name | Setup | Expected |
|---|---|---|
| G8.1 already up | health probe succeeds | resolves immediately, no spawn |
| G8.2 cold boot | nothing on the port, spawn stubbed | writes a preset containing only the vision entry, then health-polls |
| G8.3 progress emitted | as G8.2 | a progress token naming the model and the download size is sent before the wait |
| G8.4 failure surfaces | spawn fails / health never green | rejects; deepseek loop shows "Vision not available" and says the local vision model could not start |

### G9 — generators and docs

- `npm run gen:env:check` exits 0.
- No file under `docs/`, `id/`, `skills/`, `.env.example` mentions a deleted key.
- `CHANGELOG.md` has the entry under `## Unreleased`.

## Execution order

G1 → G2 → G3 (unit, independent of the rest) → G4 (needs G1+G3) → G5/G6 (need WS2) →
G7 (needs WS1+WS3) → G8 (needs WS4) → G9 last.

## Required setup

- Scratch fixture builder for fake HF cache trees (scratch dir, cleaned per test).
- A minimal hand-built GGUF header writer for G2 — enough bytes for magic, version,
  counts, and a `tokenizer.chat_template` string KV. No multi-GB fixtures.
- `fetch` stub for G3.4/G3.5.
- G4 auto-skips when `~/.cache/huggingface/hub` does not exist (CI).

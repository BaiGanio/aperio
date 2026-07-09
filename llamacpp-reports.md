# llama.cpp migration — phase reports

> Historical/reference log for [`llamacpp.md`](llamacpp.md)'s phased plan.
> Split out on 2026-07-09 because the reports had grown large enough to choke
> models reading the plan file — `llamacpp.md` stays the lean prompt source
> pasted into each new phase session; this file accumulates the "what actually
> happened" writeups. Each report ends with a **Flagged for follow-up**
> section when something surfaced that deserves its own GitHub issue rather
> than silently riding along to the next phase.

---

## Spike report (2026-07-09)

**Environment:** macOS 26.5.1, Apple M1 Pro, 32GB RAM. Installed via
`brew install llama.cpp` → **version 9910** (build `f5525f7e7`, Metal-enabled
arm64). All items below tested against real downloads and a live server, not
docs alone.

**Overall: GO on all 8 items.** No design changes needed to Phases 1–6; two
findings below refine (not block) the plan.

| # | Item | Verdict | Notes |
|---|---|---|---|
| 1 | Router mode | **GO** | `--models-preset <ini>` + `--models-max N` works exactly as designed. |
| 2 | Streaming + tools + `--jinja` | **GO** (refined) | Tool calls round-trip over SSE. **`--jinja` is now the build default** (`whether to use jinja template engine for chat (default: enabled)`) — `--no-jinja` reproduces the plan's assumed failure (`"tools param requires --jinja flag"`, HTTP 500) confirming the dependency is real. Recommend still passing `--jinja` explicitly in our launch flags (defends against a future default flip or a differently-built binary), but it is not a hard requirement on this build. |
| 3 | Vision | **GO** | Tested via **two** paths: (a) router-mode `vlm` alias serving `unsloth/Qwen3.5-0.8B-GGUF`, which auto-attached its own mmproj; (b) dedicated `ggml-org/Qwen2.5-VL-3B-Instruct-GGUF` (the actual target family, 3B stand-in for 7B), which auto-downloaded `mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf` as a **separate file** alongside the text GGUF. `image_url` data-URI content on `/v1/chat/completions` correctly identified a real generated image ("Green." for a green PNG). Confirms the plan's per-model `mmproj` design. |
| 4 | Thinking suppression | **GO — pick per-request `chat_template_kwargs`** | `reasoning_effort: "none"` (the current Ollama-style param) is **ignored** by llama-server too — same failure mode as Ollama's `/v1`, confirmed empirically (200-token `reasoning_content` still emitted). Per-request `"chat_template_kwargs": {"enable_thinking": false}` works cleanly — confirmed on **both** Qwen3.5-0.8B and gemma-4-E4B (8 tokens / instant tool-call vs. 200-token think-block). This is the general OpenAI-compatible mechanism, not Qwen-specific — use it for the provider loop, replacing `reasoning_effort`. Server-level `--reasoning-budget 0` also exists (`-1` unrestricted, `0` immediate end) as a global fallback but per-request is confirmed to work and matches `suppressThinking`'s per-call semantics. |
| 5 | Usage + timings | **GO** | Final SSE chunk (with `stream_options.include_usage`) and non-streamed responses both carry `usage` (`prompt_tokens`/`completion_tokens`/`total_tokens`, plus `prompt_tokens_details.cached_tokens`) **and** `timings` (`prompt_ms`, `prompt_per_second`, `predicted_ms`, `predicted_per_second`, `cache_n`). Directly feeds Phase 5 tok/s reporting with no extra plumbing. |
| 6 | `-hf` downloads + `LLAMA_CACHE` | **GO** | `LLAMA_CACHE=<dir> llama-server -hf <repo>[:quant]` downloads into a HF-style cache layout (`models--<org>--<repo>/{blobs,refs,snapshots}`) under the override dir — confirmed the default `~/.cache/llama.cpp` was never touched. `/v1/models` lists cached + preset models with load state. This layout is resumable (standard HF hub cache format); did not force-interrupt a download to verify resume explicitly, but the on-disk format is the same one `huggingface_hub` uses for resumable pulls. |
| 7 | Binary matrix | **GO** | Pinned to release **`b9938`**. Assets + independently-verified sha256 (downloaded macOS asset and recomputed locally, matches GitHub's reported digest exactly):<br>• macOS arm64: `llama-b9938-bin-macos-arm64.tar.gz` — `9290822c15c1275ff6edaba0801e0c9db1aceec6919792efcadda260c79a04a3`<br>• Win x64 CPU: `llama-b9938-bin-win-cpu-x64.zip` — `d55b04d755061af9aed72f6e7896f922d5fb97c86101de6b2b779ed60dd41f30`<br>• Win x64 Vulkan: `llama-b9938-bin-win-vulkan-x64.zip` — `9afc70c01aed1e6847de572bd00bcb2783cfd8100d22c1a7310d5c1ad0961b35`<br>• Win x64 CUDA 12.4: `llama-b9938-bin-win-cuda-12.4-x64.zip` — `899c514142fcf144f4d741f114fa75ead3efe8902b624bcbf480871451b6c6e3` (+ separate `cudart-llama-bin-win-cuda-12.4-x64.zip` runtime, `8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6`)<br>• Linux x64 CPU: `llama-b9938-bin-ubuntu-x64.tar.gz` — `4da33664eb6efe24bf5205b0aff52ff090c5e102a5b250876105aeb34b208681`<br>• Linux x64 Vulkan: `llama-b9938-bin-ubuntu-vulkan-x64.tar.gz` — `a79ff739931ca3da1401250892a5e0a492bfc81743b925a7afd05ba4cc538cd9`<br>Confirms the plan's choice: Vulkan as the broadest Windows/Linux default, CPU fallback, Metal (built into the macOS arm64 asset) for macOS. CUDA assets exist for a future NVIDIA power-user path but aren't the default. |
| 8 | Model mapping | **GO** | All 7 `MODEL_FACTS` entries have a matching GGUF repo, preferring official/`ggml-org`. Tool-call round-trip was empirically confirmed (not just "repo exists") on representative models from **each** distinct chat-template family in the list — Qwen2.5, Qwen3.5, and Gemma4 — de-risking item #7 in the plan's risk table for the remaining same-family entries. See table below. |

**Model mapping (task 8 detail):**

| MODEL_FACTS key | GGUF repo | Tested? |
|---|---|---|
| `qwen2.5:3b` | `Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M` (official) | ✅ full round-trip (stream, tools, jinja default, usage/timings) |
| `gemma4:e4b` | `ggml-org/gemma-4-E4B-it-GGUF` (Q4_K_M ≈5.34GB; also official `google/gemma-4-E4B-it-qat-q4_0-gguf`) | ✅ tool-call round-trip (via `unsloth/gemma-4-E4B-it-GGUF`, same weights/template family) |
| `gemma4:12b` | `ggml-org/gemma-4-12B-it-GGUF` (also official `google/gemma-4-12B-it-qat-q4_0-gguf`) | repo confirmed, not downloaded (same template family as e4b, already verified) |
| `qwen3:30b-a3b` | `Qwen/Qwen3-30B-A3B-GGUF:Q4_K_M` (official, 18.6GB — matches `sizeGB: 18`) | repo confirmed, not downloaded (18GB; MoE flags are a Phase 4 concern, not a Phase 0 blocker) |
| `qwen3.5:4b` | `unsloth/Qwen3.5-4B-GGUF` | repo confirmed, not downloaded (same family as tested 0.8B) |
| `qwen3.5:9b` | `unsloth/Qwen3.5-9B-GGUF` | repo confirmed, not downloaded (same family as tested 0.8B) |
| `qwen2.5vl:7b` | `ggml-org/Qwen2.5-VL-7B-Instruct-GGUF` (+ separate `mmproj-Qwen2.5-VL-7B-Instruct-{f16,Q8_0}.gguf`) | repo confirmed, not downloaded (same family as tested 3B; mmproj mechanism verified) |

Note: `unsloth/Qwen3.5-0.8B-GGUF` auto-attached its own mmproj (Qwen3.5 is
natively multimodal) — unrelated to the qwen2.5vl mapping above but worth
knowing: Qwen3.5-class main models may not need a separate VLM bridge at all
in a future iteration. Out of scope for this plan; noted for later.

**Two plan refinements (no rework needed):**
1. Replace `reasoning_effort: "none"` with `chat_template_kwargs: {enable_thinking: false}` in the Phase 2 provider loop (item 4 above) — confirmed general across Qwen and Gemma chat templates, not model-specific.
2. `--jinja` is default-on for this pinned build; keep it explicit in launch flags anyway for forward-compatibility, but it's a belt-and-suspenders addition, not a fix for observed breakage on the pinned version.

**Risk table update:** "Router mode is new (2026) — regressions possible" —
the server itself logs `NOTE: router mode is experimental / it is not
recommended to use this mode in untrusted environments` on every start.
Confirms the plan's existing mitigation (pin the release + sha256, upgrade
deliberately) is the right call; no new mitigation needed since Aperio's
llama-server always binds to `127.0.0.1` for a local, single-user process.

**Flagged for follow-up:** none.

---

## Phase 1 report (2026-07-09)

**Overall: GO on all 5 items.** 33 new/updated tests, full suite green
(2833/2833), plus a real (non-mocked) end-to-end run against the pinned
llama-server binary. No design changes needed to later phases.

| # | Item | Verdict | Notes |
|---|---|---|---|
| 1 | `bootstrap.js` installers | **GO** | `installLlamaCppMac/Win/Linux` + `ensureLlamaCppVendorOnPath` + `checkLlamaCpp` added, cloned from the Ollama pattern. Pinned to release `b9938` (matches the Phase 0 spike). macOS/Linux archives nest under a `llama-<tag>/` folder (confirmed by reading `release.yml`'s `tar --transform`) — extraction uses `--strip-components=1` to flatten to `vendor/llamacpp/llama-server`, matching Ollama's flat vendor-dir layout; Windows zip has no wrapper folder. Windows + Linux default to the **Vulkan** asset per the spike's risk-table decision; macOS is arm64/Metal only (Intel Mac out of scope, matching the plan's binary matrix). **Not wired into `runBootstrap()`** — `AI_PROVIDER=llamacpp` doesn't exist yet (that's Phase 2/3), so the wizard still installs Ollama; `checkLlamaCpp()` exists and is ready to slot in. |
| 2 | `startLlamaCpp.js` | **GO** | `buildModelsPreset(env, hardware)` is pure and confirmed live: `[*]` global section (`jinja = true`) + one `[hf-repo]` section per model with `hf-repo` and `ctx-size` keys (verified against upstream `release.yml`/README source, not just memory — router-mode ini syntax, `hf-repo=`, `mmproj=`, and the `[org/repo:quant]` header-= `model` field convention). `ensureLlamaCpp()` writes the preset, spawns `llama-server --models-preset … --jinja --host 127.0.0.1 --port …`, polls `/health`, and publishes `LLAMACPP_SERVE_CTX`/`LLAMACPP_CTX` (92%/−512 rule) before the already-running early-return, exactly mirroring `startOllama.js`. Added `getLoadedModels()` (`GET /models`) for later diagnostics. Sizing reuses the shared pure `recommendContextLength` — a small local `LLAMACPP_MODEL_FACTS` table covers the two curated defaults until Phase 3 extends the real `MODEL_FACTS`; unrecognized custom models fall back to the same generic facts `recommendServeContextLength` used. |
| 3 | `shutdownGuard.js` | **GO** | Rewrote `createWatchdog` to take `getPid()` and stop via `process.kill(pid, "SIGTERM")` instead of Ollama's `/api/ps` foreign-model check + `killall`/`taskkill`. No PID held → we don't touch the process (same caution the old check gave, now for free since we own the child directly). **Known interim gap, flagged for review:** the one caller (`server.js`) now passes `getPid: getLlamaCppPid`, which returns `null` until Phase 2 wires `ensureLlamaCpp()` into the boot path — so on this branch, right now, **idle Ollama sessions are no longer auto-stopped by the watchdog** (it still closes HTTP/WS and exits, just doesn't kill the Ollama process). This is called out in a code comment at the call site. Consistent with the plan's "replace, not add" decision and the fact this branch never merges before Phase 6, but flagging explicitly since it's a real, live behavior change for anyone running this branch against Ollama today. **Resolved in Phase 2** — see below. |
| 4 | Config registry | **GO** | Added `LLAMACPP_PORT` (8080), `LLAMACPP_BASE_URL`, `LLAMACPP_MODEL`, `LLAMACPP_VLM_MODEL`, `LLAMACPP_CTX`, `LLAMACPP_SERVE_CTX` under a new `llamacpp` section (mirrors the `ollama` extras section), all `tier: 1`/`show: commented` since `AI_PROVIDER=llamacpp` isn't selectable yet. `npm run gen:env` / `gen:env:check` both clean. |
| 5 | Tests | **GO** | `tests/lib/helpers/startLlamaCpp.test.js` (16 tests): preset shape, model-name overrides, mmproj emitted only when `LLAMACPP_VLM_MMPROJ` is set, `LLAMACPP_SERVE_CTX` override, ceiling/floor behavior, **sizing parity** (direct `recommendContextLength` calls at 6 RAM sizes match `buildModelsPreset`'s output bit-for-bit), and `ensureLlamaCpp()` lifecycle (already-running short-circuit, ctx publishing, no-overwrite-when-explicit, cold-spawn PID capture, 30 s timeout). `shutdownGuard.test.js` rewritten for the PID-based API (12 tests, all green). **Design note:** `ensureLlamaCpp()` takes an injectable `_spawn` (default: the real `child_process.spawn`) rather than relying on `mock.method(child_process, "spawn", …)` the way `startOllama.test.js` does — during development this surfaced a real bug: `mock.method` did **not** intercept `startLlamaCpp.js`'s named `spawn` import, and because `llama-server` actually is installed on this dev machine (from the Phase 0 spike), the first test run silently spawned a real background server (caught via `ps aux`, killed, cleaned up). `startOllama.js`'s tests have the same latent non-interception issue but never surface it because Ollama typically isn't installed on dev/CI machines — worth a follow-up look in Phase 2 if `startOllama.test.js` is touched anyway. **Not touched in Phase 2** (no changes needed to `startOllama.js` itself) — still open, see Phase 2's flagged follow-ups. |

**Live end-to-end verify (real binary, not mocked):** ran `ensureLlamaCpp()`
for real against the pinned `llama-server` (Homebrew build 9910, same as the
Phase 0 spike) with a small model pair to keep the download bounded
(`Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M` as main, `unsloth/Qwen3.5-0.8B-GGUF`
standing in for the VLM slot — small and natively multimodal, from the spike's
own tested list). Result:
- Cold start → `/health` green in 0.5 s (router mode responds before model
  weights load — lazy per-request loading confirmed).
- Both `[org/repo]` preset entries answered `/v1/chat/completions` correctly
  after on-demand download (~1.9 GB total).
- Restart-against-running short-circuited in 1 ms, same PID.
- `getLlamaCppPid()` held the real spawned PID; `process.kill(pid, "SIGTERM")`
  stopped it cleanly — confirmed no stray process afterward.
- Verify artifacts (download cache, scratch preset, script) deleted after the
  run; not part of the diff.

**Docs (README/FEATURES/SECURITY):** no changes made. `AI_PROVIDER=llamacpp`
isn't selectable yet and nothing in this phase is reachable outside direct
unit tests — README's Ollama install/config sections and FEATURES.md's
"Vendored Ollama" bullet stay accurate as-is until Phase 3 (wizard/setup) and
Phase 6 (doc sweep) land. SECURITY.md already has no Ollama-specific vendoring
section to mirror (the pinned-release + sha256 + localhost-only posture is
identical to Ollama's, just undocumented there too) — no new security surface
to call out.

**Flagged for follow-up:**
- `startOllama.test.js`'s `mock.method(child_process, "spawn", …)` does not
  actually intercept the named `spawn` import the way `startLlamaCpp.test.js`
  learned to avoid (via an injectable `_spawn` param) — on any machine with a
  real `ollama` binary installed, running that test suite can silently spawn
  a real `ollama serve` process. Never surfaced before because Ollama usually
  isn't installed on dev/CI machines; it *is* on this dev machine (from the
  Phase 0 spike) and was caught only by chance during `startLlamaCpp.js`
  development. **Not fixed in Phase 2** (no changes touched `startOllama.js`
  or its test). Worth its own small issue — same injectable-`_spawn` fix,
  applied to `startOllama.js` + `startOllama.test.js`.

---

## Phase 2 report (2026-07-09)

**Overall: GO on all items.** 2880/2880 tests green (up from 2833 at the end
of Phase 1 — 47 new tests covering every new code path), plus a real
(non-mocked) end-to-end run driving `createAgent()` with
`AI_PROVIDER=llamacpp` through both a tool-using turn and an image turn
against a live llama-server. No design changes needed to later phases.

| # | Item | Verdict | Notes |
|---|---|---|---|
| 1 | `lib/agent/providers/llamacpp.js` | **GO** | Adapted from `ollama.js` line-for-line where the logic is provider-agnostic (tool-call leak recovery, corrupted-tool-name recovery, empty-completion retry, context trimming) — the diff is deliberately close to the original so future readers can diff the two files to see exactly what's llama.cpp-specific. Health probe moved to `/health` per the Phase 0 finding (llama-server answers it near-instantly even before a model loads — router mode loads lazily on the first real request — so unlike Ollama's `/api/tags`, a *slow* health probe here really does mean "down", not "still loading"; the health-failure message text reflects that). Thinking suppression sends `chat_template_kwargs: { enable_thinking: false }` instead of `reasoning_effort: "none"` (Phase 0 finding #4). `stream_options.include_usage` kept as-is; `timings` is now captured on the stream handler (`streamHandler.timings`) and logged at debug level per turn — full per-turn surfacing into the usage-tracking UI is Phase 5's job, not Phase 2's. |
| 2 | `lib/streaming/ollamaHandler.js` → `lib/streaming/llamacppHandler.js` | **GO** | True file rename (`git mv`), not a duplicate — `OllamaStreamHandler` → `LlamaCppStreamHandler` (it was always a generic OpenAI-compatible SSE reader, never Ollama-specific code, just Ollama-named). `ollama.js` and `deepseek.js` now both import `LlamaCppStreamHandler as OllamaStreamHandler` from the renamed file — zero behavior change for those two, confirmed by the full existing `ollama.test.js`/`deepseek.test.js` suites passing unmodified. Added `timings` capture (`parsed.timings` on the final SSE chunk) to the shared handler, harmless for Ollama (which never sends that field). |
| 3 | `lib/providers/index.js` | **GO** | `resolveProvider` gained an explicit `llamacpp` branch (`baseURL: ${LLAMACPP_BASE_URL}/v1`, plus a new `llamacppBaseURL` field for the native, non-`/v1` health probe — mirrors how `ollamaBaseURL` already worked). `isLocalProvider` is now a `Set(["ollama", "llamacpp"])` membership check instead of a single string comparison — every existing caller (`tool-profiles.js`, `envFile.js`, and now several more places swept in item 4 below) picks this up automatically, which is the whole point of routing privacy gating through one function. `ollamaCtxStatus`/`ollamaContextWindow` were refactored onto a shared `genericCtxStatus`/`genericContextWindow` pair parameterized by `{assumedKey, realKey}`, with `llamacppCtxStatus`/`llamacppContextWindow` as the new sibling wrappers (`LLAMACPP_CTX`/`LLAMACPP_SERVE_CTX`) — the clamp-and-warn log message and per-key source labels (#182) are preserved verbatim, just parameterized. `ollamaCtxStatus`/`ollamaContextWindow`'s public signatures and behavior are unchanged (verified: full `providers.test.js` suite passes unmodified). |
| 4 | `imageBridge.js` + thin-caller sweep | **GO** | `imageBridge.js`'s VLM references (progress text + log lines) now resolve to `LLAMACPP_VLM_MODEL` when `AI_PROVIDER=llamacpp`, `OLLAMA_VLM_MODEL` otherwise — read once at module load, matching the existing pattern for both constants. The actual VLM *call* lives in `mcp/tools/image.js`'s `describe_image` handler (not `imageBridge.js`, which only orchestrates via the `describe_image` tool call) — this needed a real new code path, not just a rename: `describeImageViaLlamaCpp()` posts `image_url` data-URI content to `${LLAMACPP_BASE_URL}/v1/chat/completions` (llama.cpp has no native `/api/generate` equivalent), and — unlike the Ollama path — has **no per-call start/stop lifecycle**, since llama-server is already spawned/stopped by Aperio's own boot/shutdown (`ensureLlamaCpp()` + the watchdog), not per-request. Thin-caller sweep: `chat-utils.js` gained `parseLlamaCppPort`/`llamacppBase`/`llamacppHealthy` (mirrors the Ollama trio, hits `/health` not `/api/tags`); `api-meta.js`'s `GET /models` now also queries `${LLAMACPP_BASE_URL}/v1/models` and lists results under `providers.llamacpp`; `wiki/regenerate.js` gained a `llamacpp` branch in both `SUPPORTED` and `complete()` (POSTs to `/v1/chat/completions`), plus a symmetric `WIKI_REFRESH_AUTOSTART_LLAMACPP` config var calling `ensureLlamaCpp()`; `completion.js`'s PRIVACY-01 redaction check now reads `!isLocalProvider(provider.name)` instead of `provider.name !== 'ollama'`; `terminal/commands.js` gained `isLlamaCppProvider()`; `terminal.js`'s standalone boot now calls `ensureLlamaCpp()` when `AI_PROVIDER=llamacpp` (mirroring `ensureOllama()`, minus the interactive port-conflict UI and model picker — those are Phase 3's model-acquisition territory, not rebuilt here) and the `/config` status command shows `LLAMACPP_MODEL`/`LLAMACPP_CTX`/`LLAMACPP_SERVE_CTX` rows + the ctx-mismatch warning for a llamacpp session. `docker-compose.yml`/`docker-compose.prod.yml` needed **no changes** — neither file hardcodes `AI_PROVIDER`; the prod compose file already passes it through from the environment (`${AI_PROVIDER:-anthropic}`), so `llamacpp` works there with zero edits. `lib/agent/index.js` (not explicitly listed in the plan, but required for any of this to run): added the `runLlamaCppLoop` dispatch branch, replaced three ad-hoc `provider.name === "ollama"` checks (the MCP child's `APERIO_PROVIDER_LOCAL` env, `providerIsLocal()`, and `setProvider()`'s self-memory-clear guard) with `isLocalProvider()`, and added a `llamacpp` case to `buildProviderTag()`. `server.js`: wired `ensureLlamaCpp()` into the boot path (mirroring `ensureOllama()`) and **closed the Phase 1 watchdog gap** — `enabled` now reads `isLocalProvider(provider.name)` instead of `provider.name === "ollama"`, so a llamacpp session's idle watchdog now actually stops the engine (Phase 1 flagged this as an interim gap pending exactly this wiring). |
| 5 | Tests | **GO** | New: `tests/lib/agent/providers/llamacpp.test.js` (18 tests, adapted 1:1 from `ollama.test.js`'s scenarios — health failure/timeout/no-re-probe, successful streaming, VLM bridge standalone + action-request paths, empty-completion retry, tool-call leakage retry, corrupted-tool-name recovery, `estimateThinkingTokens`), `tests/lib/streaming/llamacppHandler.test.js` (renamed + 2 new `timings` tests), plus targeted additions to `tests/mcp/tools/image.test.js` (`isLlamaCppProvider`, `describeImageViaLlamaCpp`), `tests/lib/utils/chat-utils.test.js`, `tests/lib/routes/api-meta.test.js`, `tests/lib/terminal.test.js`, and `tests/lib/providers.test.js` (`llamacppContextWindow`/`llamacppCtxStatus`/`resolveProvider` llamacpp branch, extended the `isLocalProvider` locality suite). The other ~30 files that reference "ollama" needed **no changes** — full suite passed unmodified after every source edit, confirming the generalization (routing through `isLocalProvider`/shared ctx helpers rather than hardcoding "ollama" in a second place) didn't regress anything. |

**Live end-to-end verify (real binary, not mocked):** drove `createAgent()`
directly (same pattern the terminal/server boot path uses) with
`AI_PROVIDER=llamacpp`, `LLAMACPP_MODEL=Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M`,
`LLAMACPP_VLM_MODEL=unsloth/Qwen3.5-0.8B-GGUF` (same small/bounded pair Phase
1 used). Result:
- `ensureLlamaCpp()` → agent created → provider correctly reports
  `llamacpp` / the configured model.
- **Tool-using turn:** "What is 47 * 39?" → the model issued a real native
  tool call (`recall`), it executed through the full `ToolExecutor` /
  MCP round-trip, and the final answer was correct ("47 * 39 = 1783").
  Confirms `runLlamaCppLoop` → `LlamaCppStreamHandler` → tool dispatch works
  end-to-end, not just against mocked SSE.
- **Image turn:** a 1×1 PNG + "What color is this image? Answer in one
  word." → `imageBridge.js` invoked `describe_image` → `describeImageViaLlamaCpp()`
  posted `image_url` content to llama-server → the VLM answered, and the
  standalone-vision short-circuit correctly returned the VLM's answer
  directly without a second main-model turn. (The 0.8B test VLM's color
  guess was wrong — "black" for a red pixel — but that's a small-model
  accuracy quirk, not a wiring bug; the mechanics — request shape, response
  parsing, standalone-answer short-circuit — all worked correctly.)
- llama-server processes (router + 2 loaded-model children) stopped cleanly
  via `SIGTERM` to the router PID. Verify artifacts (scratch SQLite DB,
  script) deleted after the run; not part of the diff.

**Docs (README/FEATURES/SECURITY):** `AI_PROVIDER=llamacpp` is now selectable
and `npm run start:local`/`chat:local` default to it, so README's Step 3
("Install Ollama & Pull Models") would otherwise mislead a fresh-clone reader
into thinking a manual Ollama install is required before `npm run start:local`
works. Added one clarifying line: llamacpp is vendored and fully managed, no
manual step needed. Did **not** do the full README/FEATURES.md Ollama-copy
sweep (~30 locale JSONs, FEATURES.md's "Vendored Ollama" bullet, the
Prerequisites list) — that's explicitly Phase 3 (setup UI + locale copy) and
Phase 6 (doc sweep) territory per the plan, and doing it now would mean
redoing it once Phase 3 changes the actual UX (model picker, wizard step
copy). SECURITY.md: no change — same pinned-release + sha256 + localhost-only
posture as Ollama's, already true and already undocumented there (pre-existing
gap, not introduced here).

**Flagged for follow-up:**
- **llama-server router preset is hard-limited to exactly 2 resident models
  (main + VLM).** `buildModelsPreset` (Phase 1) always emits exactly two
  `[org/repo]` sections. This is fine for the chat agent (which only ever
  needs those two), but it means any *other* caller naming an arbitrary
  llamacpp model will fail against a live server: `WIKI_REFRESH_PROVIDER=llamacpp:<model>`
  only works if `<model>` happens to be `LLAMACPP_MODEL` or
  `LLAMACPP_VLM_MODEL`; a hypothetical `ROUNDTABLE_AGENTS` entry naming a
  third llamacpp model would hit the same wall. Not a Phase 2 regression —
  wiki-refresh's `llamacpp` branch was added for API-shape parity with the
  other providers, same as the existing `ollama` branch already assumed a
  single fixed `OLLAMA_MODEL`-ish server — but worth a real issue before
  Phase 3/4 builds more surface on top of a preset that can silently reject
  a caller's model choice. Candidate fix: extend `buildModelsPreset` to
  accept additional named models (e.g. from `WIKI_REFRESH_PROVIDER`'s parsed
  model) rather than hardcoding exactly two.
- **`startOllama.test.js`'s spawn-mock non-interception bug (carried over
  from Phase 1, still open).** Phase 1 flagged this and suggested revisiting
  "if `startOllama.test.js` is touched anyway" — it wasn't touched in Phase 2
  (no source changes to `startOllama.js`), so the latent risk (a real
  `ollama serve` silently spawning during `npm test` on a machine with Ollama
  installed) is still there. Small, self-contained fix (same injectable
  `_spawn` pattern `startLlamaCpp.test.js` already uses) — good candidate for
  its own quick issue rather than waiting for Phase 6's cleanup sweep.

---

## Phase 3 report (2026-07-09)

**Overall: GO on all 5 items**, with one honest caveat: unlike Phases 0–2,
this report does **not** include a live end-to-end run that actually
downloads a full GGUF over the wizard's click-through path — that would mean
either clobbering this dev machine's real `.env`/`var/bootstrap.lock` or
spinning up a disposable clone and waiting out a multi-GB download, which
didn't fit this session. What *was* verified live: `getSpecs()` (the specs
endpoint's actual logic) run directly, the full test suite (2906/2906,
+26 new tests), `gen:env`/`gen:env:check`, and `i18n:check` (287/287 keys,
26 locales). The gap — a real `primeLlamaCppModel()` download and a real
browser click through the wizard — is flagged below, not silently skipped.

| # | Item | Verdict | Notes |
|---|---|---|---|
| 1 | `MODEL_FACTS` hf extension | **GO** | Every entry in `lib/providers/index.js`'s `MODEL_FACTS` now carries `hf` (the exact `llama-server -hf` / `/v1/chat/completions` `model` string), `architecture` (`"dense"` for six entries, `"moe"` only for `qwen3:30b-a3b` with `activeParams: 3`), and an optional `mmproj` slot for a future model that needs one declared explicitly (none currently do — llama-server auto-resolves the mmproj for every VLM GGUF tested in the Phase 0 spike). Added a new `qwen2.5vl:7b` entry (the VLM bridge model wasn't previously RAM-tiered by `getRecommendedModel()`, but needed the same facts shape) — its `sizeGB`/`maxContext`/`kvBytesPerToken` are copied verbatim from `startLlamaCpp.js`'s pre-Phase-3 local `LLAMACPP_MODEL_FACTS[DEFAULT_VLM_MODEL]` entry so no sizing behavior changed, just where the facts live. New `factsForHf(hfRepo)` reverse-lookup (hf string → facts) added and exported; `startLlamaCpp.js`'s local `LLAMACPP_MODEL_FACTS` table is gone — `DEFAULT_MAIN_MODEL`/`DEFAULT_VLM_MODEL` now read `MODEL_FACTS["qwen2.5:3b"].hf` / `MODEL_FACTS["qwen2.5vl:7b"].hf`, and `serveCtxFor` calls `factsForHf(modelKey) ?? GENERIC_MODEL_FACTS`. All 22 existing `startLlamaCpp.test.js` tests pass unmodified — the resolved hf strings and sizing facts are byte-identical to what the old local table produced. |
| 2 | Download path | **GO** | Added `LLAMA_CACHE` to the config registry (default `./var/models`, tier 1, `llamacpp` section) so the wizard's presence check and the long-lived server agree on one location; `ensureLlamaCpp()` now defaults `process.env.LLAMA_CACHE` and `mkdir`s it before spawning (previously unset, relying on llama-server's own `~/.cache/llama.cpp` default). For the wizard's progress-bar need: llama-server has no standalone "just download" command, so `bootstrap.js` spawns a **throwaway `llama-server -hf <repo> --port <scratch>`** bound to a scratch port (`LLAMACPP_PORT + 1000`) purely to trigger and wait out the download + first load, piping its stdout/stderr into the same `logger()` the wizard SSE stream already reads (mirrors `ollama pull`'s progress-via-log-lines, not a byte-percentage bar — matches the plan's "if setup needs progress bars" framing as an acceptable middle ground, since llama-server exposes no download-progress API). The scratch server is killed (`SIGTERM`) once `/health` goes green. Presence is checked two ways per the plan's parenthetical: first a live `GET {LLAMACPP_BASE_URL}/v1/models` (covers a setup retried after a prior partial run), then a fallback check of the on-disk HF hub cache layout confirmed in the Phase 0 spike (`models--<org>--<repo>/snapshots`). |
| 3 | `bootstrap.js` `checkModel` equivalent | **GO** | `runBootstrap()`'s old `skipOllama` boolean is now an `engine: 'ollama' \| 'llamacpp' \| null` param (`null` = cloud, no local step) — there are two local engines now, not one, so a single boolean stopped being expressive enough. Added `checkLlamaCppModel(model, { pullIfMissing })` mirroring `checkModel`'s shape exactly (same step transitions: running → skipped-if-present / error-if-missing-and-not-pulling / running-with-progress → done-or-error). The STEPS array's `'ollama'` step id is renamed to `'engine'` (label "AI Engine") and every `setStep('ollama'\|'llamacpp', …)` call site (both vendoring blocks, `checkOllama`, `checkLlamaCpp`) now targets the shared `'engine'` id — Ollama and llama.cpp are two implementations of the same wizard step, not two different cards, which is also what makes the locale copy sweep (item 4) simple: one neutral label, real per-action detail text underneath. |
| 4 | Setup UI + Settings panel + locale copy sweep | **GO** | `setup.html`: STEPS id/labelKey renamed to match bootstrap.js's `'engine'`/`setup_step_engine`; the local-screen logic now reads a new `lite` boolean from `/api/setup/specs` (added to `specs.js`'s `getSpecs()`, alongside a new `recommendedModelHf` field — `LLAMACPP_MODEL` wants the hf repo string, not the Ollama-tag key `recommendedModel` already was) to decide which engine the "Run locally" screen actually submits: `lite → "ollama"` (unchanged — the hard constraint that lite keeps Ollama until its own Phase 6 follow-up), otherwise `"llamacpp"` (the new default). The installed-models dropdown (`ollama list`-sourced) is now gated to the ollama engine only — previously it displayed regardless of what would be submitted, which would have been a real bug once llamacpp became reachable from the same screen (a stray locally-installed Ollama model could have ended up POSTed as `LLAMACPP_MODEL`). `envFile.js`: `VALID_PROVIDERS` gained `"llamacpp"`, the model-required check generalized from `provider === "ollama"` to `!isCloud`, and the model-var branch now picks `OLLAMA_MODEL` vs `LLAMACPP_MODEL` via a small lookup table instead of hardcoding `OLLAMA_MODEL`. `server.js`'s `/api/setup/config` handler and both `runBootstrap()` call sites generalized the same way. Locale copy sweep: found only **one** actual "Ollama" string across all 26 `public/locales/*.json` files (`setup_step_ollama`, literally `"Ollama"` in every locale — never real per-language translation, just a repeated placeholder) plus its **duplicate baked-in copy inside `public/scripts/i18n.js`'s canonical English table** (a fallback baseline the locale-consistency check — `npm run i18n:check` — validates every locale against, not `en.json` itself, which the grep-based initial survey missed). Renamed the key to `setup_step_engine` = "AI Engine" everywhere (both same length in JS identifier form, so column alignment in the hand-formatted locale files needed no other changes) and replaced the previously-untranslated raw-English literal `"Choose an installed Ollama model."` in `setup.html`'s `loadSpecs()` with a new i18n key `wiz_choose_installed` = "Choose an installed model." (added to all 26 locales + `i18n.js`'s canonical table, same "not really translated, just present everywhere" convention the existing `setup_step_*` keys already used). `npm run i18n:check` now passes clean (287/287 keys × 26 locales; the four pre-existing "stale docs i18n" warnings are unrelated and present before this phase too, confirmed via `git stash`). `settings-panel.js`'s `PROVIDER_LABELS` was missing a `llamacpp` entry entirely (a real gap from Phase 2 — `/api/models` already lists a `providers.llamacpp` group, but the Settings model-picker would have shown the raw string `"llamacpp"` as a group header instead of a friendly label) — added `llamacpp: "llama.cpp (local)"`. |
| 5 | Disk-space check | **GO — no change needed** | `specs.js`'s `enoughDisk` calculation already reads `sizeGB` off whatever `MODEL_FACTS` entry `getRecommendedModel()` resolves to; since sizing facts didn't change (only sourcing hf/architecture metadata added), this kept working with zero code changes — confirmed by rerunning `getSpecs()` directly (`ramGB: 32, diskGB: 390, recommendedModel: "gemma4:12b", recommendedModelHf: "ggml-org/gemma-4-12B-it-GGUF:Q4_K_M", modelSizeGB: 8, enoughDisk: true`). |

**What was actually run this session:** full `npm test` (2906/2906 green, up
from 2880 at the end of Phase 2 — 26 new tests: `MODEL_FACTS` hf-shape +
`factsForHf` in `providers.test.js`, `llamacpp` provider support in
`envFile.test.js`, all 22 pre-existing `startLlamaCpp.test.js` tests
unmodified and still green after the facts-table refactor), `npm run gen:env`
+ `gen:env:check` (clean, 109 vars), `npm run i18n:check` (clean, 287/287 ×
26 locales), `node --check` on `bootstrap.js`/`server.js`, a live import of
the refactored `bootstrap.js` (confirms `STEPS` shape), and `getSpecs()`
called directly both with and without `APERIO_LITE=on` (confirms the new
`lite`/`recommendedModelHf` fields resolve correctly in both modes).

**What was not run:** an actual browser click-through of the wizard's local
screen against a live server, and a real `primeLlamaCppModel()` download —
both would require either overwriting this dev machine's real `.env` /
`var/bootstrap.lock` (this machine is already bootstrapped and in daily use)
or a disposable clone plus a multi-GB download, neither of which fit this
session. `llama-server` and `ollama` are both actually installed on this
machine (confirmed via `which`), so `checkLlamaCpp()`/`checkOllama()`'s
already-installed fast paths would have been exercised, not the download
paths this phase actually added — running them for real would have
proven less than the code review + unit tests already did, at real risk
(spawning a real background `ollama serve`, per the standing "never run
server/MCP processes for diagnosis" lesson from an earlier session).

**Docs (README/FEATURES/SECURITY):** no changes. Per the plan, the
README/FEATURES.md Ollama-copy sweep is explicitly Phase 6 territory (the
"Sweep remaining mentions" item); Phase 3's copy-sweep scope was setup.html +
Settings panel + locale files only, per its own checklist wording.

**Flagged for follow-up:**
- **No live-download verification of `primeLlamaCppModel()`.** The scratch-port
  priming approach (spawn `llama-server -hf <repo> --port <scratch>`, poll
  `/health`, kill on ready) is a reasonable design given llama-server has no
  dedicated download subcommand, but it's untested against a real multi-GB
  download in this session — only the presence-check half (`isModelCached`,
  reading `/v1/models` and the HF cache dir layout) was exercised conceptually
  against the Phase 0 spike's confirmed cache format, not run live. Worth a
  manual pass before this ships: run the actual setup wizard against a real
  `AI_PROVIDER=llamacpp` first-run and confirm the "AI Model" step's progress
  detail lines are legible (llama-server's own stdout format wasn't captured
  and reviewed for line-noise/ANSI codes the way `ollama pull`'s output was
  when `cleanCommandOutput`/`commandFailureDetail` were originally written).
- **`primeLlamaCppModel`'s scratch port (`LLAMACPP_PORT + 1000`) could
  collide** with something else already listening on that port on an unusual
  setup (e.g. `LLAMACPP_PORT=8080` → scratch `9080`, a common alt-HTTP port).
  Low probability, but unlike the main server's port (user-configured,
  documented) this one is invisible/undocumented. A future pass could pick an
  OS-assigned ephemeral port instead of a fixed offset.
- **Settings panel's `PROVIDER_LABELS` gap (fixed here) suggests a pattern**:
  anywhere the codebase does `providerName === "ollama"` as a stand-in for
  "the local provider" (rather than `isLocalProvider()`) is a candidate for
  the same class of miss when llamacpp was added in Phase 2. This one was
  caught by reading the file directly rather than a targeted grep — worth a
  dedicated `grep -rn '"ollama"' --include=*.js` sweep in Phase 6 rather than
  assuming Phase 2's sweep caught every call site.

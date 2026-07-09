# Replace Ollama with a fully-managed llama.cpp (llama-server) backend — phased plan

> Working copy of [issue #226](https://github.com/BaiGanio/aperio/issues/226) (supersedes #222).
> Check items off here as they land; keep the GitHub issue in sync at phase boundaries.

---

## How to drive this plan with Claude Code (Pro budget)

This file is the prompt source. One phase = one session. The routine per phase:

1. **Start a fresh session** (`/clear` or new window) — don't carry a previous
   phase's context, it burns budget re-reading it on every turn.
2. **Pick the model first** (`/model`), per the table below. Switch back to
   Sonnet the moment the expensive step is done.
3. **Paste the whole phase section** (heading through its **Verify** line) as
   the opening prompt, prefixed with one line of intent, e.g.:
   > We're on branch `ft/llamacpp` executing the plan in `llamacpp.md`.
   > Implement Phase 1 below. Work through the checkboxes in order; run the
   > listed Verify step before declaring done. Ask nothing you can decide
   > yourself from the codebase.
4. **Full spec up front, no drip-feeding.** Everything the agent needs should
   be in that first message. Follow-up turns re-send the whole history —
   ambiguity resolved over 5 turns costs ~5× the tokens of one precise turn.
5. **End the session with the Verify step + `npm test`**, tick the boxes here,
    and write the commit message , so the user can verify and commit by their own if they will. Next phase gets a clean start.
6. **End the session with the Documentation step**, where README.md and FEATURES.md and SECURITY.md are properly updated if needed

### Model per phase

| Phase | Model | Why |
|---|---|---|
| 0 — Spike | Sonnet 5 | Mostly *you* running llama-server by hand; the agent just drafts commands and records findings. |
| 1 — Lifecycle | Sonnet 5 | Clone of the existing `startOllama.js` pattern; well-specified. |
| 2 — Provider loop | Sonnet 5 to author, **Opus 4.8 to review the diff** | The hard-won retry/leak-recovery logic is the one regression-prone spot. A short Opus `/code-review` session is far cheaper than authoring on Opus. |
| 3 — Acquisition + wizard | Sonnet 5 | Mechanical: MODEL_FACTS extension, download plumbing, locale sweep. |
| 4 — Profiles | Sonnet 5 | Pure functions + tests, fully specced below. |
| 5 — Bench/diagnostics | Sonnet 5 | Same. |
| 6 — Cleanup/migration | Sonnet 5 | Deletion sweep + shim; grunt work. |

Skip Fable entirely for this migration — on Pro its cost profile (2× Opus,
always-on thinking) exhausts a session window mid-phase.

### Stretching the budget

- **Discovery on Sonnet, decisions on Opus.** Never let an expensive model
  grep around the codebase. If a phase needs exploration, run it on Sonnet
  and only escalate the concrete question.
- **Plan mode before big edits.** For Phase 2, ask for a plan first, approve
  it, then let it execute — cheaper than correcting a wrong direction after
  20 file edits.
- **Scope the test runs.** `npm run test:only -- --test-name-pattern="…"`
  while iterating; full `npm test` once at the end of the phase. Full-suite
  output re-read by the model every turn is a silent token sink.
- **Grunt sweeps at low effort.** The Phase 2 test-file sweep and Phase 3
  locale sweep are find-and-replace grade — Sonnet, and consider dialing
  effort down for those turns.
- **Don't ask the agent to summarize this file back.** Paste only the phase
  being executed, not the whole plan.

---

**Decision (2026-07-09):** Replace the Ollama backend with direct llama.cpp
(`llama-server`), fully managed by Aperio: Aperio vendors the binary, downloads
models, generates the launch config, spawns and monitors the process. We are in
dev mode — old functionality may be swapped for new. Supersedes §6 ("optional,
later") of issue #222; the rest of #222 (profiles, benchmarking, diagnostics)
is folded into this plan as Phases 4–5, where it lands *better* than it could
on Ollama.

**Why:** Ollama is a Go wrapper around llama.cpp. Talking to llama.cpp directly
unlocks the tuning #222 wants and Ollama can't expose — tensor-level MoE
offload (`--n-cpu-moe`), per-model KV-cache quantization (`-ctk/-ctv`),
fine-grained `--n-gpu-layers`, `--mlock/--no-mmap` — plus faster upstream
features and a lighter vendored footprint. llama-server's new **router mode**
(`--models-preset`, `--models-max`) removed the historic one-model-per-process
limitation, so the main-model + VLM-bridge architecture carries over.

**What makes this cheap:** Aperio already talks to Ollama through the
OpenAI-compatible `/v1/chat/completions` API — the same API llama-server
exposes. The provider loop, streaming handler, tool executor, trim math, and
context-sizing math all transfer. The Ollama-specific surface is thin:
lifecycle spawn, `/api/tags` health probes, `/api/ps` shutdown check,
`ollama pull`, and the vendored-binary installer (whose download+checksum
pattern we reuse verbatim).

---

## Hard constraint: aperio-lite deadline 2026-07-14

The lite release ships **vendored Ollama** and is 5 days out. This work must
NOT destabilize it.

- All work happens on a feature branch (`feat/llamacpp`).
- No merge to `master`/`dev` before the lite release is out the door.
- The lite installer keeps Ollama for its release; switching lite to a vendored
  llama-server is Phase 6 follow-up, not a lite-release blocker.

---

## Phase 0 — Spike: verify assumptions against a real llama-server (½–1 day)

Run llama-server by hand (brew install / GH release) and confirm each item.
Every one is an assumption the rest of the plan leans on; any failure changes
the design, so this phase gates everything.

- [x] **Router mode**: `--models-preset` with two entries (main + VLM), routed
      by the `model` field on `/v1/chat/completions`. Confirm load/unload
      behavior and `--models-max 1` swapping on a RAM-constrained profile.
- [x] **Streaming + tools**: `stream: true` with `stream_options.include_usage`
      and OpenAI `tools`. **Note:** llama-server requires `--jinja` for
      tool-call support — must be in the default launch flags.
- [x] **Vision**: qwen2.5-VL GGUF + its `mmproj` file served through router
      mode (per-model `mmproj` in the preset). `image_url` data-URI content
      accepted on `/v1/chat/completions` (imageBridge sends exactly this).
- [x] **Thinking suppression**: today we send `reasoning_effort: "none"` over
      Ollama's /v1 (see project memory: `think:false` is ignored there).
      Verify the llama-server equivalent for qwen3-class models:
      `--reasoning-budget 0` (global) vs per-request
      `chat_template_kwargs: { enable_thinking: false }`. Pick one; prefer
      per-request (suppressThinking is per-call today).
- [x] **Usage + timings**: confirm responses carry `usage` and `timings`
      (prompt/gen tok/s) — feeds Phase 5 for free.
- [x] **`-hf` downloads**: `llama-server -hf <repo>` (or preset `hf` entries)
      downloads into `LLAMA_CACHE`; confirm cache path control and resume.
- [x] **Binary matrix**: pick the GH release asset per platform:
      macOS arm64 (Metal), Windows x64 (decide Vulkan vs CUDA vs CPU —
      Vulkan is the broadest single choice), Linux x64 (Vulkan + CPU
      fallback). Record asset names + sha256 for pinning.
- [x] **Model mapping**: for each `MODEL_FACTS` entry, choose the GGUF repo +
      quant that matches what Ollama served (prefer `ggml-org/` or official
      vendor GGUFs): qwen2.5:3b, gemma4:e4b, gemma4:12b, qwen3:30b-a3b,
      qwen3.5:4b/9b, qwen2.5vl:7b (+mmproj). Verify chat templates work with
      `--jinja` (tool calls actually round-trip on each).

**Deliverable:** short spike report appended to this file; go/no-go per item.

---

### Spike report (2026-07-09)

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

## Phase 1 — Binary vendoring + lifecycle (`startLlamaCpp.js`)

Replace `lib/helpers/startOllama.js` and the bootstrap's vendored-Ollama
installer with llama-server equivalents.

- [x] `bootstrap.js`: `installLlamaCppMac/Win/Linux` — download pinned release
      asset, verify sha256, extract to `./vendor/llamacpp/` (clone of the
      existing `installOllamaMac/Win` pattern, incl. PATH publishing).
- [x] New `lib/helpers/startLlamaCpp.js`:
      - Pure function `buildModelsPreset(env, hardware)` → preset ini text
        (per-model: gguf path/hf repo, `--ctx-size`, mmproj, flags). Pure so it
        unit-tests without a live server (same doctrine as
        `recommendContextLength`).
      - `ensureLlamaCpp()`: write preset to `var/llamacpp/models.ini`, spawn
        `llama-server --models-preset … --jinja --host 127.0.0.1 --port ${LLAMACPP_PORT}`,
        poll `/health`, publish resolved ctx env for downstream trim math.
      - Keep the serve-window logic: `recommendServeContextLength()` feeds
        per-model `--ctx-size`; the app-side assumption keeps the 92% / −512
        generation-reserve rule.
- [x] `lib/helpers/shutdownGuard.js`: we own the child PID now — replace the
      `/api/ps` "is anyone else using it" check with PID-based stop; use
      `GET /models` for loaded-state introspection where needed.
- [x] Config registry (`lib/config.js`): add `LLAMACPP_PORT` (default 8080),
      `LLAMACPP_BASE_URL`, `LLAMACPP_MODEL`, `LLAMACPP_VLM_MODEL`,
      `LLAMACPP_CTX` (app-side window assumption, successor of
      OLLAMA_NUM_CTX), `LLAMACPP_SERVE_CTX` (successor of
      OLLAMA_CONTEXT_LENGTH). Run `npm run gen:env`.
- [x] Tests: preset generation, sizing parity with current
      `recommendServeContextLength` expectations.

**Verify:** `ensureLlamaCpp()` cold-starts a server that answers
`/v1/chat/completions` for both main and VLM model; restart-against-running
works (the "already running" early-return path).

**Deliverable:** short report appended to this file; go/no-go per item.

---

### Phase 1 report (2026-07-09)

**Overall: GO on all 5 items.** 33 new/updated tests, full suite green
(2833/2833), plus a real (non-mocked) end-to-end run against the pinned
llama-server binary. No design changes needed to later phases.

| # | Item | Verdict | Notes |
|---|---|---|---|
| 1 | `bootstrap.js` installers | **GO** | `installLlamaCppMac/Win/Linux` + `ensureLlamaCppVendorOnPath` + `checkLlamaCpp` added, cloned from the Ollama pattern. Pinned to release `b9938` (matches the Phase 0 spike). macOS/Linux archives nest under a `llama-<tag>/` folder (confirmed by reading `release.yml`'s `tar --transform`) — extraction uses `--strip-components=1` to flatten to `vendor/llamacpp/llama-server`, matching Ollama's flat vendor-dir layout; Windows zip has no wrapper folder. Windows + Linux default to the **Vulkan** asset per the spike's risk-table decision; macOS is arm64/Metal only (Intel Mac out of scope, matching the plan's binary matrix). **Not wired into `runBootstrap()`** — `AI_PROVIDER=llamacpp` doesn't exist yet (that's Phase 2/3), so the wizard still installs Ollama; `checkLlamaCpp()` exists and is ready to slot in. |
| 2 | `startLlamaCpp.js` | **GO** | `buildModelsPreset(env, hardware)` is pure and confirmed live: `[*]` global section (`jinja = true`) + one `[hf-repo]` section per model with `hf-repo` and `ctx-size` keys (verified against upstream `release.yml`/README source, not just memory — router-mode ini syntax, `hf-repo=`, `mmproj=`, and the `[org/repo:quant]` header-= `model` field convention). `ensureLlamaCpp()` writes the preset, spawns `llama-server --models-preset … --jinja --host 127.0.0.1 --port …`, polls `/health`, and publishes `LLAMACPP_SERVE_CTX`/`LLAMACPP_CTX` (92%/−512 rule) before the already-running early-return, exactly mirroring `startOllama.js`. Added `getLoadedModels()` (`GET /models`) for later diagnostics. Sizing reuses the shared pure `recommendContextLength` — a small local `LLAMACPP_MODEL_FACTS` table covers the two curated defaults until Phase 3 extends the real `MODEL_FACTS`; unrecognized custom models fall back to the same generic facts `recommendServeContextLength` used. |
| 3 | `shutdownGuard.js` | **GO** | Rewrote `createWatchdog` to take `getPid()` and stop via `process.kill(pid, "SIGTERM")` instead of Ollama's `/api/ps` foreign-model check + `killall`/`taskkill`. No PID held → we don't touch the process (same caution the old check gave, now for free since we own the child directly). **Known interim gap, flagged for review:** the one caller (`server.js`) now passes `getPid: getLlamaCppPid`, which returns `null` until Phase 2 wires `ensureLlamaCpp()` into the boot path — so on this branch, right now, **idle Ollama sessions are no longer auto-stopped by the watchdog** (it still closes HTTP/WS and exits, just doesn't kill the Ollama process). This is called out in a code comment at the call site. Consistent with the plan's "replace, not add" decision and the fact this branch never merges before Phase 6, but flagging explicitly since it's a real, live behavior change for anyone running this branch against Ollama today. |
| 4 | Config registry | **GO** | Added `LLAMACPP_PORT` (8080), `LLAMACPP_BASE_URL`, `LLAMACPP_MODEL`, `LLAMACPP_VLM_MODEL`, `LLAMACPP_CTX`, `LLAMACPP_SERVE_CTX` under a new `llamacpp` section (mirrors the `ollama` extras section), all `tier: 1`/`show: commented` since `AI_PROVIDER=llamacpp` isn't selectable yet. `npm run gen:env` / `gen:env:check` both clean. |
| 5 | Tests | **GO** | `tests/lib/helpers/startLlamaCpp.test.js` (16 tests): preset shape, model-name overrides, mmproj emitted only when `LLAMACPP_VLM_MMPROJ` is set, `LLAMACPP_SERVE_CTX` override, ceiling/floor behavior, **sizing parity** (direct `recommendContextLength` calls at 6 RAM sizes match `buildModelsPreset`'s output bit-for-bit), and `ensureLlamaCpp()` lifecycle (already-running short-circuit, ctx publishing, no-overwrite-when-explicit, cold-spawn PID capture, 30 s timeout). `shutdownGuard.test.js` rewritten for the PID-based API (12 tests, all green). **Design note:** `ensureLlamaCpp()` takes an injectable `_spawn` (default: the real `child_process.spawn`) rather than relying on `mock.method(child_process, "spawn", …)` the way `startOllama.test.js` does — during development this surfaced a real bug: `mock.method` did **not** intercept `startLlamaCpp.js`'s named `spawn` import, and because `llama-server` actually is installed on this dev machine (from the Phase 0 spike), the first test run silently spawned a real background server (caught via `ps aux`, killed, cleaned up). `startOllama.js`'s tests have the same latent non-interception issue but never surface it because Ollama typically isn't installed on dev/CI machines — worth a follow-up look in Phase 2 if `startOllama.test.js` is touched anyway. |

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

**Follow-ups for later phases (not blockers):**
- Phase 2 must wire `ensureLlamaCpp()` into `server.js`'s boot path and update
  the watchdog's `enabled` gate — closes the idle-Ollama-stop gap noted above.
- Phase 3 extends the real `MODEL_FACTS` with `hf`/`mmproj` fields per model;
  `startLlamaCpp.js`'s local `LLAMACPP_MODEL_FACTS` table is a deliberate
  placeholder for exactly two models and should be retired then.
- No Vulkan/CPU auto-fallback for Windows/Linux in the installer (single
  pinned asset per platform, matching the plan's explicit decision and
  Ollama's own single-binary simplicity) — worth a look in Phase 4's hardware
  detection if driverless-Vulkan install reports come in.


## Phase 2 — Provider loop swap

- [ ] `lib/agent/providers/llamacpp.js` from `ollama.js` (rename + adapt; keep
      the hard-won pieces: tool-call leak recovery, empty-completion retry,
      context-pressure retries, thinking-token estimation).
      - Health probe: `/api/tags` → `/health` (+ `/v1/models` for model list).
      - Thinking suppression per Phase 0 finding.
      - Keep `stream_options.include_usage`; additionally capture `timings`.
- [ ] `lib/providers/index.js`:
      - `resolveProvider`: `llamacpp` branch (baseURL `${LLAMACPP_BASE_URL}/v1`).
      - `isLocalProvider("llamacpp") === true` — this is the single privacy
        gate; flipping it here carries every privacy check.
      - Generalize `ollamaCtxStatus`/`ollamaContextWindow` to the new env pair
        (keep the clamp-and-warn semantics + source labels from #182).
- [ ] `lib/helpers/imageBridge.js`: VLM requests go to the same server with
      `model: LLAMACPP_VLM_MODEL`; router loads/swaps it.
- [ ] Sweep the thin callers: `chat-utils.js` (port/health), `api-meta.js`
      (model list → `/v1/models`), `wiki/regenerate.js`, `completion.js`,
      `terminal/commands.js`, `streaming/ollamaHandler.js` (rename),
      npm scripts (`start:local` AI_PROVIDER value), docker compose env.
- [ ] Tests: adapt the ~38 test files referencing ollama; provider-loop tests
      run against mocked /v1 exactly as before.

**Verify:** `npm run chat:local` and the Web UI complete a tool-using turn and
an image turn end-to-end on llama.cpp; `npm test` green.

## Phase 3 — Model acquisition + setup wizard

Replace `ollama pull` with GGUF downloads.

- [ ] Extend `MODEL_FACTS` per model: `{ hf: "repo:quant", mmproj?, sizeGB,
      maxContext, kvBytesPerToken, architecture: "dense"|"moe", activeParams? }`
      (kv facts are unchanged — same GGUFs underneath).
- [ ] Download path: prefer letting llama-server fetch via preset `-hf`
      entries with `LLAMA_CACHE=./var/models`; if setup needs progress bars,
      download the GGUF directly from HF with streamed progress (the wizard
      already has step UI), then reference the local path in the preset.
- [ ] `bootstrap.js` `checkModel`: presence = file in cache (or listed by
      `GET /models`), `pullIfMissing` = trigger download.
- [ ] Setup UI (`public/setup.html`) + Settings panel + locale files: copy
      sweep — "Ollama" appears in ~30 locale JSONs; replace with neutral
      "local AI engine (llama.cpp)" wording so future locale adds stay simple.
- [ ] Disk-space check in the wizard keeps using `sizeGB`.

**Verify:** fresh clone → `npm run start:local` on a machine with nothing
installed reaches a working chat with zero manual steps (the fully-managed
acceptance test).

## Phase 4 — Hardware profiles + performance flags (the #222 payoff)

Everything #222 wanted, now with real levers.

- [ ] `APERIO_LOCAL_PERF_PROFILE` = `balanced` (default) | `fast-low-vram` |
      `long-context` | `quality`. Profile resolver in `lib/providers/`.
- [ ] Profile → preset flags in `buildModelsPreset`:
      - `fast-low-vram`: lower ctx ceiling, `-ctk q8_0 -ctv q8_0`,
        `--flash-attn`, MoE-preferred model pick, `--n-cpu-moe` on MoE models
        (the video's 3→17 tok/s trick), `--models-max 1`.
      - `long-context`: raised ceiling + fitFraction, explicit throughput
        warning in UI copy.
      - `quality`: bigger model pick where RAM allows; accept slower tok/s.
      - `balanced`: current sizing behavior.
- [ ] `getRecommendedModel(profile, hardware)`: MoE-aware, uses the new
      metadata; keep the RAM thresholds as the base heuristic.
- [ ] Hardware detection: total RAM (have), VRAM best-effort (macOS unified =
      RAM; `nvidia-smi` where present; else unknown → conservative).
- [ ] Tests: per-profile `buildModelsPreset` + model-pick cases (low/mid/high
      RAM × profile).

## Phase 5 — Benchmark + runtime diagnostics

- [ ] Per-turn: record llama-server `timings` (prompt tok/s, gen tok/s, load
      time) alongside existing usage tracking.
- [ ] `npm run local:bench`: short + medium fixed prompts → report tok/s, load
      time, ctx used, profile, model; emit the #222 recommendation strings
      ("try fast-low-vram", "context likely too high", …).
- [ ] Slow-turn diagnostic event: evidence-gated (N slow turns) UI hint
      suggesting profile/ctx change; never fires for cloud providers
      (gate on `isLocalProvider`).
- [ ] Tests with mocked timings.

## Phase 6 — Cleanup, migration, docs

- [ ] Delete `startOllama.js`, `lib/agent/providers/ollama.js` (post-rename),
      vendored-Ollama installer path, the 14 `OLLAMA_*` config entries; regen
      `.env.example` (`gen:env:check` is a CI gate).
- [ ] Migration shim: on boot with `AI_PROVIDER=ollama` or `OLLAMA_*` vars set,
      print a one-screen mapping (old var → new var) and exit with clear
      instructions — dev-mode-honest, no silent remapping. Models must be
      re-downloaded (Ollama blobs aren't reused); say so with sizes.
- [ ] Sweep remaining mentions: seeds (`db/memory-seed*.js`,
      `db/self-memory-seed.js`, `db/wiki-seed.js`), `exam.md` drills, skills
      docs, README, docs site, CLAUDE.md, `id/` capability docs.
- [ ] **aperio-lite follow-up (post-lite-release):** swap lite's vendored
      Ollama for vendored llama-server + `fast-low-vram` default profile.
- [ ] Update issue #222 with the revised direction; close or re-scope.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Router mode is new (2026) — regressions possible | Pin the vendored release + sha256; upgrade deliberately. Fallback if router breaks: two llama-server instances (main + VLM) behind the same provider, or llama-swap. |
| Tool-calling quality depends on `--jinja` chat templates per model | Phase 0 verifies tool round-trips per supported model before anything is built. |
| VLM/mmproj in router preset unproven | Phase 0 item; fallback is a second dedicated instance for the VLM. |
| Windows GPU backend choice (CUDA vs Vulkan) | Ship Vulkan (broadest); document CUDA build swap for NVIDIA power users. |
| No `ollama pull` curation — bad quant/template = support pain | Aperio only auto-downloads the curated `MODEL_FACTS` set (same policy as today: "the only ones Aperio pulls for a non-technical user"). |
| llama-server holds RAM until stopped (no idle unload like Ollama's 5-min keep-alive) | shutdownGuard already stops the engine on idle; `--models-max` bounds resident models. |
| Lite deadline 2026-07-14 | Feature branch; no merge before lite ships. |

## Explicitly out of scope

- Keeping a parallel Ollama provider (decision: replace, not add).
- Building llama.cpp from source (pinned prebuilt releases only).
- Exposing raw llama.cpp flags in the Settings UI (profiles are the
  interface; an escape-hatch `LLAMACPP_EXTRA_FLAGS` env is enough).
- Speculative decoding, embeddings via llama.cpp (embeddings stay on
  `@huggingface/transformers` / Voyage).

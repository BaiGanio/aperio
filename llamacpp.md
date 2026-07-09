# Replace Ollama with a fully-managed llama.cpp (llama-server) backend — phased plan

> Working copy of [issue #226](https://github.com/BaiGanio/aperio/issues/226) (supersedes #222).
> Check items off here as they land; keep the GitHub issue in sync at phase boundaries.
>
> **Phase reports live in [`llamacpp-reports.md`](llamacpp-reports.md)**, not here —
> this file is the prompt source pasted into each phase session, and inline
> report prose was choking models reading it as the file grew. Each phase
> section below ends with a one-line status + a link into the reports file.

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
    and write the commit message, so the user can verify and commit by their
    own will. Append the phase report to `llamacpp-reports.md` (not this
    file). Next phase gets a clean start.
6. **End the session with the Documentation step**, where README.md and FEATURES.md and SECURITY.md are properly updated if needed
7. **Flag anything issue-worthy.** If the phase surfaces a real gap, latent
   bug, or deferred decision that shouldn't just ride along silently to the
   next phase, call it out explicitly in the report and in the session's
   final message — so it can become a tracked GitHub issue instead of getting
   lost in a wall of phase-report prose.

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

**Verify / Deliverable:** short spike report — **GO on all 8 items**, no
design changes needed. Full findings: [`llamacpp-reports.md` § Spike
report](llamacpp-reports.md#spike-report-2026-07-09).

---

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

**Verify / Deliverable:** `ensureLlamaCpp()` cold-starts a server that answers
`/v1/chat/completions` for both main and VLM model; restart-against-running
works. **GO on all 5 items**, 33 new/updated tests, full suite green
(2833/2833), plus a real end-to-end run against the pinned binary. Full
findings: [`llamacpp-reports.md` § Phase 1
report](llamacpp-reports.md#phase-1-report-2026-07-09).

## Phase 2 — Provider loop swap

- [x] `lib/agent/providers/llamacpp.js` from `ollama.js` (rename + adapt; keep
      the hard-won pieces: tool-call leak recovery, empty-completion retry,
      context-pressure retries, thinking-token estimation).
      - Health probe: `/api/tags` → `/health` (+ `/v1/models` for model list).
      - Thinking suppression per Phase 0 finding.
      - Keep `stream_options.include_usage`; additionally capture `timings`.
- [x] `lib/providers/index.js`:
      - `resolveProvider`: `llamacpp` branch (baseURL `${LLAMACPP_BASE_URL}/v1`).
      - `isLocalProvider("llamacpp") === true` — this is the single privacy
        gate; flipping it here carries every privacy check.
      - Generalize `ollamaCtxStatus`/`ollamaContextWindow` to the new env pair
        (keep the clamp-and-warn semantics + source labels from #182).
- [x] `lib/helpers/imageBridge.js`: VLM requests go to the same server with
      `model: LLAMACPP_VLM_MODEL`; router loads/swaps it.
- [x] Sweep the thin callers: `chat-utils.js` (port/health), `api-meta.js`
      (model list → `/v1/models`), `wiki/regenerate.js`, `completion.js`,
      `terminal/commands.js`, `streaming/ollamaHandler.js` (rename),
      npm scripts (`start:local` AI_PROVIDER value), docker compose env.
- [x] Tests: adapt the ~38 test files referencing ollama; provider-loop tests
      run against mocked /v1 exactly as before.

**Verify / Deliverable:** `npm run chat:local` and the Web UI complete a
tool-using turn and an image turn end-to-end on llama.cpp; `npm test` green.
**GO on all items** — 2880/2880 tests green, plus a real (non-mocked)
end-to-end run: a tool-using turn (real `recall` tool call, correct answer)
and an image turn (real VLM call through the new `describe_image` llama.cpp
path) both round-tripped against a live llama-server. Full findings, plus two
flagged follow-ups worth their own issues: [`llamacpp-reports.md` § Phase 2
report](llamacpp-reports.md#phase-2-report-2026-07-09).

## Phase 3 — Model acquisition + setup wizard

Replace `ollama pull` with GGUF downloads.

- [x] Extend `MODEL_FACTS` per model: `{ hf: "repo:quant", mmproj?, sizeGB,
      maxContext, kvBytesPerToken, architecture: "dense"|"moe", activeParams? }`
      (kv facts are unchanged — same GGUFs underneath).
- [x] Download path: prefer letting llama-server fetch via preset `-hf`
      entries with `LLAMA_CACHE=./var/models`; if setup needs progress bars,
      download the GGUF directly from HF with streamed progress (the wizard
      already has step UI), then reference the local path in the preset.
- [x] `bootstrap.js` `checkModel`: presence = file in cache (or listed by
      `GET /models`), `pullIfMissing` = trigger download.
- [x] Setup UI (`public/setup.html`) + Settings panel + locale files: copy
      sweep — "Ollama" appears in ~30 locale JSONs; replace with neutral
      "local AI engine (llama.cpp)" wording so future locale adds stay simple.
- [x] Disk-space check in the wizard keeps using `sizeGB`.

**Verify:** fresh clone → `npm run start:local` on a machine with nothing
installed reaches a working chat with zero manual steps (the fully-managed
acceptance test). **GO on all items** (with one caveat flagged below on the
real download path); full findings: [`llamacpp-reports.md` § Phase 3
report](llamacpp-reports.md#phase-3-report-2026-07-09).

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
| Router preset is currently fixed to exactly 2 resident models (main + VLM) | Flagged in Phase 2 report — extend `buildModelsPreset` in Phase 3/4 before any feature (e.g. `WIKI_REFRESH_PROVIDER=llamacpp:<other-model>`, round-table with a third llamacpp model) assumes an arbitrary model name works. |

## Explicitly out of scope

- Keeping a parallel Ollama provider (decision: replace, not add).
- Building llama.cpp from source (pinned prebuilt releases only).
- Exposing raw llama.cpp flags in the Settings UI (profiles are the
  interface; an escape-hatch `LLAMACPP_EXTRA_FLAGS` env is enough).
- Speculative decoding, embeddings via llama.cpp (embeddings stay on
  `@huggingface/transformers` / Voyage).

# Tests — Aperio local media generation and video tools

> Companion to [`media-generation-and-video-tools.md`](media-generation-and-video-tools.md).
> Domain: software feature — adapter contract, security, asynchronous jobs, and
> isolated media smoke tests.
>
> **Verify-first:** before implementation, T1–T5 must fail because Aperio has no
> generation tools, media queue, renderer adapter, or video analysis path.

## 1. Coverage map

| Plan step | Test group | Coverage |
|---|---|---|
| M0.1–M0.2, M3.7 | T1 | Schema validation, fake adapter lifecycle, MCP tool contract |
| M1.3, M3.7 | T2 | Artifact boundaries, session ownership, traversal/symlink rejection |
| M2.5–M2.6, M3.7 | T3 | Queue bounds, progress, idempotency, cancellation, cleanup |
| M1.4, M4.10 | T4 | Provenance manifest, secret redaction, sampled video analysis |
| M3.8, M4.9–M4.10 | T5 | Capability discovery and isolated ComfyUI image/video smoke tests |
| M5.11–M5.12 | T6 | Feature flag, disabled default, docs approval gate |

## 2. Test cases

### T1 — Contract and fake adapter

- **T1.1 Valid image request**
  - Input/setup: prompt, allowed image preset, dimensions, session ID.
  - Expected: request validates and returns a job ID; no renderer process is launched by validation.
  - Assertions: normalized schema, bounded dimensions, explicit `kind: image`.
  - Edge cases: empty prompt, unknown preset, negative dimensions, oversized dimensions.
- **T1.2 Valid video request**
  - Input/setup: prompt, short-video preset, duration and FPS within limits.
  - Expected: request validates and returns a queued job.
  - Assertions: duration/FPS/frame-count limits are enforced.
  - Edge cases: zero duration, excessive duration, non-integer FPS, unsupported input artifact.
- **T1.3 Fake adapter lifecycle**
  - Input/setup: deterministic adapter that emits queued/running/progress/succeeded.
  - Expected: submit → status → collect returns a protected artifact and manifest.
  - Assertions: adapter methods are called in order; terminal status is stable and collect is idempotent.
  - Edge cases: adapter unavailable, malformed output, duplicate collect.

### T2 — Artifact and security boundaries

- **T2.1 Output containment**
  - Input/setup: fake adapter returns relative and absolute output names.
  - Expected: only approved artifact workspace paths are accepted.
  - Assertions: `..`, absolute paths, null bytes, and symlink escapes are rejected.
  - Edge cases: Unicode normalization, encoded traversal, output name collisions.
- **T2.2 Session ownership**
  - Input/setup: session A creates a job; session B requests status/download/cancel.
  - Expected: B cannot access or mutate A's private job or artifact.
  - Assertions: authorization failure contains no path or prompt leakage.
  - Edge cases: guessed IDs, replayed URLs, terminal jobs.

### T3 — Queue and lifecycle

- **T3.1 Concurrency bound**
  - Input/setup: submit more jobs than the configured concurrency and queue capacity.
  - Expected: only the configured number runs; excess jobs are queued or rejected deterministically.
  - Assertions: active count never exceeds the limit; queue length is bounded.
  - Edge cases: renderer hangs, process crash, rapid submit burst.
- **T3.2 Progress and reconnect**
  - Input/setup: fake adapter emits repeated progress and a simulated client reconnect.
  - Expected: progress is coalesced; reconnect receives current state once.
  - Assertions: no duplicate deliverables, no terminal-state resurrection.
  - Edge cases: progress decreases, missing progress, disconnect during completion.
- **T3.3 Cancellation and cleanup**
  - Input/setup: cancel a running job with temporary files present.
  - Expected: adapter cancellation is requested, job becomes cancelled, temp files are removed.
  - Assertions: cancellation is idempotent; a later completion cannot overwrite cancelled state.
  - Edge cases: cancel queued job, cancel already terminal job, cleanup failure logged without secret data.

### T4 — Provenance and analysis

- **T4.1 Manifest completeness**
  - Input/setup: completed image and video jobs.
  - Expected: manifest records kind, model, workflow hash, seed, dimensions, time, and artifact digest.
  - Assertions: manifest validates against its schema and contains no API key/base64 payload.
  - Edge cases: missing optional seed, unknown renderer version, failed job.
- **T4.2 Sampled video analysis**
  - Input/setup: short fixture video in isolated scratch storage.
  - Expected: only bounded frame samples are decoded and passed to local vision analysis.
  - Assertions: original video remains unchanged; derived analysis links to job/artifact; memory use is bounded.
  - Edge cases: corrupt video, very large resolution, no keyframes, audio-only file.

### T5 — Capability and real local renderer smoke tests

- **T5.1 Disabled capability**
  - Input/setup: fresh config with media feature flag off and no ComfyUI endpoint.
  - Expected: capability metadata says unavailable; MCP tools return an honest disabled response.
  - Assertions: no network connection, process launch, or artifact is created.
  - Edge cases: stale renderer URL, malformed configuration.
- **T5.2 Image workflow smoke test**
  - Input/setup: isolated local ComfyUI, pinned image workflow, tiny test dimensions.
  - Expected: one generated image completes through the Aperio adapter.
  - Assertions: output MIME/type, artifact containment, manifest, and preview URL.
  - Edge cases: renderer returns error, timeout, partial output.
- **T5.3 Video workflow smoke test**
  - Input/setup: isolated local ComfyUI, pinned short Wan/LTX workflow, low resolution.
  - Expected: one short playable video completes through the same queue and adapter.
  - Assertions: playable container, duration/FPS metadata, bounded temp usage, cleanup.
  - Edge cases: cancellation during sampling, renderer restart, unsupported codec.

### T6 — Rollout and documentation

- **T6.1 Feature flag default**
  - Expected: media generation is off in a clean install and does not alter startup.
  - Assertions: existing image-reading tools remain functional; no renderer side effect.
- **T6.2 Documentation approval gate**
  - Expected: behavior docs are changed only after explicit user approval per file.
  - Assertions: proposed file list matches plan §6; no silent doc edits.

## 3. Test execution order

1. T1 and T2 — pure contract/security tests; establish red baseline first.
2. T3 — queue/lifecycle tests using the fake adapter.
3. T4 — provenance and bounded analysis tests.
4. T5 — capability tests, then isolated real renderer smoke tests.
5. T6 — rollout and documentation checks last.

## 4. Required setup

- Node native test runner and existing Aperio test fixtures.
- Isolated temporary DB, artifact root, session, and non-default port for e2e tests.
- Fake media adapter fixture with deterministic output and failure modes.
- Optional local ComfyUI installation with one pinned image and one short-video workflow.
- Test models small enough for the available GPU; real smoke tests must not use the
  repository's live `var/` tree or a user's production renderer.


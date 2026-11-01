# Aperio v2 — Feature Ledger

Safety net 2 of 3 (see `aperio-v2.md` → "How we do not forget anything").
**One row for every v1 feature, MCP tool, UI panel and skill. No cell is blank.**

Created 2026-11-01 (step **S0.3**). Test group: **T0.3**.
All paths are read at the tag: `git show archive/v1-final:<path>`.

**Status words** — `core` = in v2 from the start · `later` = returns through the Phase 5 return
gate · `parked` = returns only if a test proves it helps a small model · `never` = archive only.

Inventory source (at the tag): 20 `## ` headings in `FEATURES.md` · 16 entries in `mcp/tools/`
· 44 scripts in `public/scripts/` · 34 directories in `skills/`.
Lesson IDs point at `lessons-ledger.md`.

---

## A. Features (`FEATURES.md` headings)

| Feature | v2 status | v1 files (at tag) | v1 tests (at tag) | Issues | Lessons | Ported in |
|---|---|---|---|---|---|---|
| Memory | **core** | `mcp/tools/memory.js`, `lib/memory/`, `lib/handlers/memory/`, `lib/handlers/ws/memories.js`, `db/sqlite/` | `tests/unit/tools/memory.test.js`, `tests/integration/store/store.test.js`, `tests/integration/db/contract/memories.test.js`, `tests/unit/memory/recall-corpus.test.js`, `tests/unit/memory/tokenCount.test.js`, `tests/unit/handlers/ws/memories.test.js` | #570 | L-M01, L-M02, L-C13, L-C17 | — (S2.3, S2.6, S2.7, S2.8) |
| Self-Memory | **parked** | `mcp/tools/self-memory.js`, `mcp/tools/self-wiki.js`, `db/self-memory-seed.js`, `id/self-nature.md` | `tests/unit/tools/self-memory.test.js`, `tests/unit/tools/self-wiki.test.js`, `tests/integration/db/self-memories.test.js`, `tests/integration/db/self-wiki.test.js`, `tests/integration/db/contract/self-memory.test.js` | — | Q1 | — |
| Wiki | **later** | `mcp/tools/wiki.js`, `lib/handlers/wiki/`, `lib/routes/api-wiki.js` | `tests/unit/wiki/wikiHandlers.test.js`, `tests/unit/wiki/wikiQueries.test.js`, `tests/unit/wiki/regenerate.test.js`, `tests/integration/db/contract/wiki.test.js`, `tests/integration/routes/api-wiki.test.js`, `tests/e2e/real-app/real-app-wiki.test.js` | — | — | — |
| Code Graph | **later** | `lib/codegraph/`, `lib/codegraph/backends/`, `lib/handlers/codegraph/`, `mcp/tools/codegraph.js`, `lib/routes/api-codegraph.js` | `tests/unit/codegraph/*` (12 files), `tests/integration/codegraph/*` (5), `tests/integration/routes/api-codegraph.test.js`, `tests/e2e/real-app/real-app-codegraph.test.js` | #539 | L-C01, L-C08 | — |
| Doc Graph | **later** | `lib/docgraph/`, `lib/docgraph/backends/`, `lib/docgraph/facts/`, `lib/handlers/docgraph/`, `mcp/tools/docgraph.js`, `lib/routes/api-docgraph.js` | `tests/unit/docgraph/*` (13 files), `tests/integration/docgraph/*` (4), `tests/docint/**`, `tests/integration/routes/api-docgraph.test.js` | #250, #251, #532 | L-C01, L-C23 | — |
| Extraction Templates | **later** | `lib/handlers/extraction/`, `lib/db-connect/extraction.js`, `mcp/tools/extraction.js` | `tests/unit/db-connect/extraction.test.js`, `tests/integration/handlers/extraction/*` (4), `tests/integration/mcp/tools/extraction.test.js`, `tests/integration/db-connect/extraction-encryption.test.js` | #250 | L-C10 | — |
| Databases (external SQL client) | **later** | `lib/db-connect/`, `lib/db-connect/drivers/`, `mcp/tools/database.js`, `mcp/tools/data.js`, `lib/routes/api-database.js`, `lib/routes/api-data.js` | `tests/unit/drivers/*` (3), `tests/unit/db-connect/*` (3), `tests/integration/db-connect/*` (4), `tests/integration/routes/api-database.test.js`, `tests/integration/handlers/database-confirm.test.js`, `tests/unit/handlers/database-amounts.test.js` | — | L-C04, L-C05, L-C10 | — |
| Files & Documents | **core** | `mcp/tools/files.js`, `mcp/tools/files/`, `lib/routes/paths.js`, `lib/helpers/secureFile.js`, `lib/attachments/` | `tests/integration/routes/paths.test.js`, `tests/integration/mcp/tools/files.test.js`, `tests/integration/helpers/secureFile.test.js`, `tests/unit/attachments/*` (6), `tests/unit/tools/validateWrittenFile.test.js` | #528 | L-C03, L-C21, L-C20 | — (S2.9) |
| Shell | **later** | `mcp/tools/shell.js`, `mcp/tools/shell/` | `tests/integration/mcp/tools/shell.test.js` | — | L-C09 | — |
| Web & Image | **later** | `mcp/tools/web.js`, `mcp/tools/image.js`, `lib/helpers/ssrfGuard.js`, `lib/helpers/netGuard.js`, `lib/workers/preprocessImage.js` | `tests/unit/tools/web.test.js`, `tests/integration/mcp/tools/image.test.js`, `tests/unit/helpers/ssrfGuard.test.js`, `tests/unit/helpers/netGuard.test.js`, `tests/unit/workers/preprocessImage.test.js` | — | — | — |
| GitHub | **later** | `mcp/tools/github.js`, `lib/routes/github-webhook.js` | `tests/unit/tools/github.test.js`, `tests/integration/routes/github-webhook.test.js`, `tests/integration/db/contract/issue-triage.test.js` | #187 | — | — |
| Agent & Reasoning — loop + providers | **core** | `lib/agent/index.js`, `lib/agent/providers/llamacpp.js`, `lib/providers/`, `lib/streaming/`, `lib/helpers/startLlamaCpp.js`, `lib/context/` | `tests/unit/providers/llamacpp*.test.js`, `tests/unit/streaming/llamacppHandler*.test.js`, `tests/integration/helpers/startLlamaCpp.test.js`, `tests/integration/agent.test.js`, `tests/unit/context/trim.test.js` | #570 | L-M03 → L-M09, L-M15, L-M18 | — (S2.5) |
| Agent & Reasoning — AgentSpec, bundles, roundtable, turn planner, agent jobs, sub-agents | **never** | `lib/agent/spec.js`, `lib/agent/turn-planner.js`, `lib/workers/agent-scheduler.js`, `lib/workers/roundtable.js`, `lib/agent/bundle*` | `tests/unit/agent/spec.test.js`, `tests/unit/agent/turn-planner.test.js`, `tests/harness/planning.test.js`, `tests/harness/spawn.test.js`, `tests/integration/workers/roundtable.test.js`, `tests/integration/db/contract/agent-jobs.test.js` | #498, #361, #320, #319, #187 | L-C03 | — |
| Agent & Reasoning — middleware stack (`Testing lifecycle middleware`) + large-result artifact offload (`Testing large-result artifacts`) | **never** | `lib/agent/middleware*`, `lib/context/artifactStore.js`, `lib/context/toolResultOffload.js` | `tests/unit/agent/middleware.test.js`, `tests/integration/context/artifactStore.test.js`, `tests/integration/context/toolResultOffload.test.js`, `tests/integration/context/artifactRetrieval.test.js` | — | L-M18 | — |
| Storage — SQLite + sqlite-vec + FTS5 | **core** | `db/sqlite/`, `db/migrations-sqlite/`, `lib/embeddings/` | `tests/integration/db/sqlite.test.js`, `tests/unit/db/vec-fallback.test.js`, `tests/unit/db/tables.test.js`, `tests/integration/embeddings/reindex.test.js`, `tests/unit/helpers/embeddings.test.js`, `tests/unit/helpers/embedding-queue.test.js` | #528 | L-C13, L-C17, L-C20 | — (S2.3, S2.4) |
| Storage — Postgres + pgvector, DB encryption, import/export | **later** | `db/postgres/`, `db/migrations/`, `lib/helpers/sessionCrypto.js` | `tests/unit/db/postgres*.test.js`, `tests/integration/db/postgres*.test.js`, `tests/integration/db/encrypt.test.js`, `tests/integration/db/reconcile-decrypt.test.js`, `tests/unit/db/migration-lockstep.test.js`, `tests/unit/db/store-surface-parity.test.js`, `tests/integration/db/contract/import-export.test.js` | — | L-C18, TR16 | — |
| Deterministic assistant-behavior harness | **core** (becomes the v2 eval) | `tests/harness/` | `tests/harness/harness.test.js`, `tests/harness/no-tool-use-diagnostic.test.js`, `tests/harness/run-scenario.js`, `tests/harness/scenarios/*` (14) | #355, #356, #357, #358, #359, #321 | L-M10, L-M11, L-M14, L-M16 | — (S2.1) |
| Interfaces — web UI (chat, streaming, themes) | **core** (rebuilt) | `public/index.html`, `public/styles/`, `public/scripts/` (see table C) | `tests/e2e/ui/*`, `tests/browser/smoke/app-shell.spec.js`, `tests/integration/public/*` | #338 | L-P01, L-C11 | — (Phase 3) |
| Interfaces — terminal CLI, voice, TTS, i18n, autocomplete | **later** | `lib/terminal/`, `lib/terminal.js`, `lib/emitters/cliEmitter.js`, `public/scripts/tts.js`, `voice.js`, `i18n.js`, `autocomplete.js` | `tests/integration/terminal/*` (7), `tests/unit/terminal/*` (2), `tests/unit/lib/terminal.js`, `tests/integration/terminalStrings.test.js`, `tests/integration/locale-drift-sync.test.js`, `tests/unit/public/voice-transcript.test.js` | #539, #421, #422 | L-C06 | — |
| Security & Hardening | **core** (cut to the file gate + socket schema) | `lib/security/`, `lib/privacy/`, `lib/routes/paths.js`, `lib/helpers/authGuard.js`, `lib/helpers/staticAuth.js`, `lib/helpers/redactSecrets.js` | `tests/unit/security/*` (3), `tests/unit/privacy/*` (2), `tests/unit/helpers/authGuard.test.js`, `tests/unit/helpers/redactSecrets.test.js`, `tests/e2e/real-app/real-app-security.test.js`, `tests/integration/csp-reenablement.test.js` | — | L-C03, L-C09, L-C11, L-C21, L-C22, TR17 | — (S2.9, S2.11) |
| Onboarding & Install (Aperio-lite) | **later** — except a small install path at **S4.3** | `public/setup.html`, `public/scripts/setup.js`, `lite.js`, `.github/lite/`, `install.sh`, `start.ps1`, `vendor/llamacpp` | `tests/unit/lite/launcher-parity.test.js`, `tests/unit/lib/lite-defaults.test.js`, `tests/integration/public/setup-progress.test.js`, `tests/unit/server/firstRun.test.js`, `tests/e2e/bootstrap/bootstrap.test.js` | — | L-C19, TR4 | — |
| Ops (CI, reporters, shutdown, workers) | **core** (cut to tests/lint/guards/CodeQL/audit) | `.github/workflows/`, `tests/reporters/`, `lib/server/`, `lib/workers/` | `tests/integration/server/shutdown.test.js`, `tests/unit/lib/server-shutdown.test.js`, `tests/unit/reporters/*` (3), `tests/integration/server/backgroundWorkers.test.js` | #569 | L-C02, L-C07, TR6 | S1.3 |
| Ops — VMs / k3s / Docker deploy, autotune, tier bench, continuous audit, bot workflows, mascot + demo pipelines | **never** | `lib/vms/`, `audit/`, `skills/autotune/`, `scripts/model-tier-bench.js`, `docs/assets/mascot/`, `var/demo/` | `tests/integration/vms/*` (6), `tests/integration/helpers/modelTierBench.test.js`, `tests/integration/scripts/model-tier-bench.test.js`, `tests/integration/helpers/localBench.test.js` | — | L-C02 | — |
| Config registry + resolver | **core** | `lib/config.js`, `lib/config-resolver.js`, `lib/config-sync.js`, `scripts/gen-env-example.js` | `tests/unit/lib/config-resolver.test.js`, `tests/unit/lib/config-registry-metadata.test.js`, `tests/unit/lib/config-sync.test.js`, `tests/integration/routes/config-*.test.js` (3), `tests/integration/scripts/gen-env-example.test.js` | #569 | L-P03, L-C22, TR15 | — (S2.2) |

> Two notes. (1) *Agent & Reasoning*, *Storage*, *Interfaces* and *Ops* each split into more than one
> row, because the heading mixes a `core` part with a `later` or `never` part. (2) *Config registry*
> is not a `FEATURES.md` heading, but it is a `core` v2 step (S2.2), so it gets a row.

## B. MCP tools (`mcp/tools/` at the tag)

The MCP **server** is `later` (see the decisions table). A `core` tool below means the *behaviour*
comes back as an in-process function in S2.8 — not as an MCP tool.

| Tool file | v2 status | Feature row | v1 tests (at tag) | Issues | Lessons | Ported in |
|---|---|---|---|---|---|---|
| `memory.js` | **core** (5 in-process tools) | Memory | `tests/unit/tools/memory.test.js` | #570 | L-M01, L-M15 | — (S2.8) |
| `files.js` + `files/` | **core** (via `gatedRead`/`gatedWrite`) | Files & Documents | `tests/integration/mcp/tools/files.test.js` | #528 | L-C21 | — (S2.9) |
| `self-memory.js` | **parked** | Self-Memory | `tests/unit/tools/self-memory.test.js` | — | Q1 | — |
| `self-wiki.js` | **parked** | Self-Memory | `tests/unit/tools/self-wiki.test.js` | — | Q1 | — |
| `wiki.js` | **later** | Wiki | `tests/unit/wiki/wikiHandlers.test.js` | — | — | — |
| `codegraph.js` | **later** | Code Graph | `tests/unit/codegraph/codegraphHandlers.test.js` | #539 | L-C08 | — |
| `docgraph.js` | **later** | Doc Graph | `tests/unit/docgraph/docgraphHandlers.test.js`, `tests/integration/mcp/docgraph-clear-session-cache.test.js` | #250, #532 | L-C23 | — |
| `extraction.js` | **later** | Extraction Templates | `tests/integration/mcp/tools/extraction.test.js` | #250 | L-C10 | — |
| `database.js` | **later** | Databases | `tests/integration/routes/api-database.test.js` | — | L-C04, L-C05 | — |
| `data.js` | **later** | Databases | `tests/integration/handlers/data/dataHandlers.test.js` | — | L-C04 | — |
| `shell.js` + `shell/` | **later** | Shell | `tests/integration/mcp/tools/shell.test.js` | — | L-C09 | — |
| `web.js` | **later** | Web & Image | `tests/unit/tools/web.test.js` | — | — | — |
| `image.js` | **later** | Web & Image | `tests/integration/mcp/tools/image.test.js` | — | — | — |
| `github.js` | **later** | GitHub | `tests/unit/tools/github.test.js` | #187 | — | — |
| MCP server + child process (`mcp/index.js`, `lib/agent/mcp-connect.js`) | **later** (thin wrapper at a return gate) | — | `tests/integration/mcp/index.test.js`, `tests/integration/mcp/tool-profile-coverage.test.js`, `tests/integration/mcp/redaction-map-side-channel.test.js`, `tests/integration/mcp/generate-files.test.js` | — | L-C22 | — |
| Tool profiles / executor / schema check | **core** (cut to one tool interface) | — | `tests/unit/agent/tool-profiles.test.js`, `tests/unit/tools/executor.test.js`, `tests/integration/tools/schemaCheck.test.js` | — | L-C04, L-M15 | — (S2.8) |

## C. UI panels (`public/scripts/` at the tag — 44 entries)

Phase 3 rebuilds the `core` rows as Web Components. A `later` panel stays in the archive until
its feature returns. Every row is covered by the Phase 3 table in `aperio-v2.md`.

| Script | v2 status | Feature row | Ported in |
|---|---|---|---|
| `chat.js` | **core** (rebuilt) | Interfaces — web UI | — (S3.3) |
| `input-bar.js` | **core** (rebuilt) | Interfaces — web UI | — (S3.3) |
| `markdown.js` | **core** (rebuilt) | Interfaces — web UI | — (S3.3) |
| `rendering.js` | **core** (rebuilt) | Interfaces — web UI | — (S3.3) |
| `streaming/` | **core** (rebuilt) | Interfaces — web UI | — (S3.3) |
| `stream-prefix-guard.js` | **core** | Interfaces — web UI | — (S3.3) |
| `memory-table.js` | **core** (rebuilt) | Memory | — (S3.4) |
| `memories.js` | **core** (rebuilt) | Memory | — (S3.4) |
| `api.js` | **core** (becomes a service module) | Interfaces — web UI | — (S3.0) |
| `theme-and-timestamp.js` | **core** | Interfaces — web UI | — (S3.7) |
| `font-scale.js` | **core** | Interfaces — web UI | — (S3.7) |
| `settings-panel.js` | **core** (cut hard) | Config registry | — (S3.6) |
| `settings.js` | **core** (cut hard) | Config registry | — (S3.6) |
| `http-guard.js` | **core** | Security & Hardening | — (S3.0) |
| Memory inbox (approve captures) | **core** — **new in v2, no v1 file** | Memory | — (S3.5) |
| `settings-overlay.js` | **later** | Config registry | — |
| `sessions.js` | **later** | Interfaces — web UI | — |
| `system.js` | **later** | Ops | — |
| `autocomplete.js` | **later** | Interfaces — terminal/voice/i18n | — |
| `i18n.js` | **later** | Interfaces — terminal/voice/i18n | — |
| `lang-map.js` | **later** | Interfaces — terminal/voice/i18n | — |
| `world-paths.js` | **later** | Interfaces — terminal/voice/i18n | — |
| `tts.js` | **later** | Interfaces — terminal/voice/i18n | — |
| `voice.js` | **later** | Interfaces — terminal/voice/i18n | — |
| `wiki-panel.js` | **later** | Wiki | — |
| `codegraph-panel.js` | **later** | Code Graph | — |
| `codegraph-map.js` | **later** | Code Graph | — |
| `codegraph-atlas.js` | **later** | Code Graph | — |
| `docgraph-panel.js` | **later** | Doc Graph | — |
| `document-preview.js` | **later** | Doc Graph | — |
| `spreadsheet-preview.js` | **later** | Doc Graph | — |
| `db-panel.js` | **later** | Databases | — |
| `db-connections-panel.js` | **later** | Databases | — |
| `dataset-lab-panel.js` | **later** | Databases | — |
| `paths-panel.js` | **later** | Files & Documents | — |
| `skills-panel.js` | **later** | Skills | — |
| `capabilities-panel.js` | **later** | Agent & Reasoning — loop | — |
| `setup.js` | **later** | Onboarding & Install | — |
| `lite.js` | **later** | Onboarding & Install | — |
| `self-memory-table.js` | **parked** | Self-Memory | — |
| `agents-panel.js` | **never** | Agent & Reasoning — AgentSpec etc. | — |
| `agent-steps-builder.js` | **never** | Agent & Reasoning — AgentSpec etc. | — |
| `github-triage-panel.js` | **never** | GitHub (#187 closed) | — |
| `ambient.js` | **never** | Interfaces — web UI | — |
| `identity-info-modal.js` | **never** | Agent & Reasoning — AgentSpec etc. | — |

## D. Skills (`skills/` at the tag — 34 directories)

Four skills are `core` and each one is cut down for small models (decisions table).
Every skill is measured on and off at **S2.10**.

| Skill | v2 status | Note | Ported in |
|---|---|---|---|
| `memory-protocol` | **core** | Cut down. The one rule depends on it. | — (S2.10) |
| `working-with-files` | **core** | Cut down. Pairs with the S2.9 file gate. | — (S2.10) |
| `agent-conduct` | **core** | Cut down. | — (S2.10) |
| `conversation-lifecycle` | **core** | Cut down. | — (S2.10) |
| `codegraph` | **later** | With Code Graph. | — |
| `docgraph` | **later** | With Doc Graph. | — |
| `document-intelligence` | **later** | With Doc intelligence. | — |
| `wiki` | **later** | With Wiki. | — |
| `preprocess-image` | **later** | With Web & Image. | — |
| `preprocess-pdf` | **later** | With Doc intelligence. | — |
| `pdf` | **later** | With Doc intelligence. | — |
| `docx` | **later** | With Doc intelligence. | — |
| `docx-advanced` | **later** | With Doc intelligence. | — |
| `pptx` | **later** | With Doc intelligence. | — |
| `xlsx` | **later** | With Doc intelligence. | — |
| `doc-coauthoring` | **later** | With Doc intelligence. | — |
| `webapp-testing` | **later** | Returns with Playwright breadth (#338 covers the core UI). | — |
| `frontend-design` | **later** | Phase 3 uses the design tokens directly, not a skill. | — |
| `canvas-design` | **later** | Visual work; L-P01 applies. | — |
| `theme-factory` | **later** | With more than one theme. | — |
| `design-randomizer` | **never** | Not needed. | — |
| `debugging-and-error-recovery` | **later** | Re-measure at a return gate (L-M13). | — |
| `test-driven-development` | **later** | TDD is a plan rule in v2, not a skill. | — |
| `code-review-and-quality` | **later** | Re-measure at a return gate. | — |
| `code-simplification` | **later** | Re-measure at a return gate. | — |
| `coding-standards` | **later** | AP1–AP9 guards replace it in core. | — |
| `security-and-hardening` | **later** | Core security is code (S2.9, S2.11), not a skill. | — |
| `reasoning-planning` | **never** | Planning UX is `never` (#498, #361). | — |
| `tool-integration` | **never** | One tool interface replaces it (S2.8). | — |
| `handoff` | **never** | Session handoff is a developer habit, not a skill. | — |
| `prompt-optimizer` | **never** | Overfits (L-M10). | — |
| `skill-creator` | **never** | Four skills do not need a factory. | — |
| `autotune` | **never** | In the `never` list of the decisions table. | — |
| `wayfinder` | **never** | Belongs to the v1 launch map, which is dropped. | — |

---

## Status roll-up

Checked by `scripts/check-ledgers.mjs`, so these numbers cannot drift from the tables.

| Status | A. Features | B. Tools | C. Panels | D. Skills |
|---|---|---|---|---|
| `core` | 9 | 3 | 15 | 4 |
| `later` | 11 | 11 | 24 | 22 |
| `parked` | 1 | 2 | 1 | 0 |
| `never` | 3 | 0 | 5 | 8 |
| **rows** | **24** | **16** | **45** | **34** |

Section A has 24 rows for 20 `FEATURES.md` headings: four headings split into a `core` part and a
`later`/`never` part, and `Config registry` is added as a `core` step that has no heading.
Section C has 45 rows for 44 scripts: the memory inbox is new in v2 and has no v1 file.

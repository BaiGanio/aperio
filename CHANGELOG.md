# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

## [0.56.0] — 2026-06-10

### Added
- wtf2 once more

---


## [0.55.0] — 2026-06-10

### Added
- wtf once more

---


## [0.54.0] — 2026-06-10

### Added
- fetch_url offset paging, curl in shell allowlist, exam §0 agent paths

---


## [0.53.0] — 2026-06-10

### Added
- the exam

---


## [0.52.0] — 2026-06-08

### Added
- closed #2 (What happens when swithcing embedding provides? How the Aperio handles this?)

---


## [0.51.2] — 2026-05-31

### Fixed
- crash on idle shutdown: the watchdog now emits SIGTERM instead of   calling process.exit directly, routing through gracefulShutdown for proper ONNX cleanup

---


## [0.51.1] — 2026-05-28

### Fixed
- removed .sqlite directories from tracking and add to .gitignore

---


## [0.51.0] — 2026-05-28

### Added
- extending codegraph to index more languages beyond JS/TS

---


## [0.50.1] — 2026-05-23

### Fixed
- sanitized null content in OpenAI-compatible payloads

---


## [0.50.0] — 2026-05-13

### Added
- excluded files

---


## [0.49.0] — 2026-05-12

### Added
- e2e test

---


### Added
- Embedding retry queue for resilient vector writes
- Score tracking
- Docker production configuration
- Full multi-language support for 24 EU languages (DA, FI, SV, IT, PT, NL, DE, ES, FR and more) with flag-based navbar switcher
- Response stats badge: answer tokens, thinking tokens, tok/s, elapsed time
- Session pagination and delete
- Persistent session history (file + DB)
- DeepSeek V4 Flash thinking mode — `reasoning_content` forwarded in subsequent calls

### Fixed
- LanceDB and Postgres store serialization
- Concurrency bug where `streamUsage` was shared across concurrent WebSocket clients
- `GET /api/memories` now calls `store.listAll()` correctly
- Reasoning chain replay
- Locale placeholder values (de.json)
- Hardcoded English strings in `message-handler.js`, `index.js`, `setup.html`
- Chat UI font sizes for comfortable reading at 100% zoom
- Reasoning display rendering in chat
- Image uploads switched from base64 vision blocks to disk-based files
- Streaming bubble finalized before starting a new response round
- Markdown fence rendering
- Context window tracking
- LanceDB `FloatVector<Float>` missing `.every()`/`.some()` — embeddings appeared absent on every restart
- Ctrl+C crash in the local server
- Memory import/export
- `initEmbeddings` wiring in `server.js`
- DB bulk-insert cap (500) and embeddings request timeout
- `toggleReasoning` now treats `null` (default) as ON

---

## [2.44.0] — 2026-04-19

### Added
- Updated whoami endpoint

### Fixed
- `wsEmitter.js` path resolution on start

### Dependencies
- `sanitize-html` 2.17.2 → 2.17.3

---

## [2.43.8] — 2026-04-16

### Fixed
- FUNDING.yml configuration

---

## [2.43.7] — 2026-04-16

### Fixed
- FUNDING.yml follow-up corrections

---

## [2.43.6] — 2026-04-16

### Fixed
- Missing version string in build output

### Dependencies
- `hono` 4.12.12 → 4.12.14

---

## [2.43.5] — 2026-04-14

### Fixed
- Node 24 compatibility

---

## [2.43.4] — 2026-04-14

### Fixed
- Release asset SHA checksums

---

## [2.43.3] — 2026-04-14

### Fixed
- CI test trigger

---

## [2.43.2] — 2026-04-14

### Fixed
- Workflow dispatch on SHA-based refs

---

## [2.43.1] — 2026-04-14

### Changed
- Simplified base AI model configuration

### Fixed
- Version string in ZIP artifact name
- Tag bump logic in release workflow
- Workflow dispatch configuration

---

## [2.43.0-beta.3] — 2026-04-14

### Fixed
- CI trigger for dev branch

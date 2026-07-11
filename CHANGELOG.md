# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## Unreleased

### Added

- Model download/load progress banner — llama.cpp weight pulls/loads inside a request now surface as a self-dismissing main-window banner (live GB, staged `downloading → loading → ready`, fades 5 s after ready) instead of a stale label crowding the header model chip; warm models stay silent
- Skill quick-access chips collapse to a single measured row with a `+N more` expander (wraps open, `− less` collapses), recomputed on resize
- Branch conversation redesign — labeled "Branch" button, a discoverable entry in the new `+` actions menu, and a friendly inline confirm card replacing the browser `confirm()`

- Terminal context pressure indicator: navbar now shows `ctx N%` when context usage exceeds warning threshold (#189)
- Ollama provider: cached tool schema serialization across tool-call loop iterations to avoid redundant `zodToJsonSchema` transforms (#189)

- First-class OpenAI Codex CLI provider with Aperio MCP tools, sandbox controls,
  persisted per-session resume, setup/configuration UI, background completions,
  round-table support, documentation, and provider-contract tests.


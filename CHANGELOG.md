# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## Unreleased

### Added

- Memory-aware llama.cpp VLM preset selection: native-vision main models omit
  the bridge, while oversized main/VLM pairs use router swap mode
  (`models-max = 1`) and report the decision at startup.
- Model download/load progress banner — llama.cpp weight pulls/loads inside a request now surface as a self-dismissing main-window banner (live GB, staged `downloading → loading → ready`, fades 5 s after ready) instead of a stale label crowding the header model chip; warm models stay silent
- Skill quick-access chips collapse to a single measured row with a `+N more` expander (wraps open, `− less` collapses), recomputed on resize
- Branch conversation redesign — labeled "Branch" button, a discoverable entry in the new `+` actions menu, and a friendly inline confirm card replacing the browser `confirm()`

- Terminal context pressure indicator: navbar now shows `ctx N%` when context usage exceeds warning threshold (#189)
- Ollama provider: cached tool schema serialization across tool-call loop iterations to avoid redundant `zodToJsonSchema` transforms (#189)

- First-class OpenAI Codex CLI provider with Aperio MCP tools, sandbox controls,
  persisted per-session resume, setup/configuration UI, background completions,
  round-table support, documentation, and provider-contract tests.

### Fixed

- llama.cpp no longer duplicates GGUF models into the repo. It previously forced
  `LLAMA_CACHE=./var/models`, so llama-server re-downloaded every model into the
  app folder even when the user already had it in the standard Hugging Face hub
  cache — a full duplicate hoard (tens of GB). The cache now defaults to that
  shared HF hub cache (`HF_HUB_CACHE`, else `$HF_HOME/hub`, else
  `~/.cache/huggingface/hub`) — the same location `llama-cli` and every other HF
  tool use — so existing models are reused and nothing is stored in-repo. Set
  `LLAMA_CACHE` to override.
- Tool-call failure observability (#223): error-log entries were attributed to the
  first `node_modules` stack frame (e.g. `readable-stream/_stream_transform.js`)
  instead of the real call site — the caller resolver now skips `node_modules` and
  points at app code. Weak-model tool-call failures (leak / corrupted native name /
  system-prompt echo) were only ever logged to the console at `warn` level and left
  no on-disk record; they are now appended to a persistent ledger at
  `var/toolrepair/failures.tsv` (`ts, model, kind, persisted, detail`), with
  `persisted=1` marking the cases a retry did not recover.

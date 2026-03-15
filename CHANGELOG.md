# Changelog

All notable changes to Aperio are documented here.

---

## [Unreleased]

### Added
- feat: Restrict file operations to specific directories (comma-separated) (deb1490)
- Reasoning model support — qwen3 and deepseek-r1 with collapsible thinking bubble
- Reasoning toggle — show/hide reasoning bubble from the header
- Local embeddings via Ollama — mxbai-embed-large, zero external calls
- `OLLAMA_NO_TOOLS` flag — deepseek-r1 uses text-mode tool interception
- Server-side "remember that" interception for no-tools models
- Path safety guard — `APERIO_ALLOWED_PATHS` restricts write_file/append_file
- `✦ preparing answer…` indicator after reasoning completes
- Copy button on code blocks
- Auto-scroll during reasoning and streaming
- Honest startup message — shows embedding coverage at launch
- `CONTRIBUTING.md` and Security section in README
- Model selection guide in Troubleshooting

### Fixed
- Double memory suggestion block on reasoning models
- Duplicate stream_end causing double output
- Embeddings not saving — wrong API endpoint and response field for Ollama
- MCP child process not inheriting env vars
- Reasoning bubble not collapsing after tool call loop
- `streamingBubble` cleared too early by `reasoning_done`
- `write_file` hallucination on init — tools disabled for greeting
- `llama3.1` JSON tool call interception with trailing response support

### Changed
- chore: updated setup with CMD for migrations (bc619fa)
- chore: landing page update (fdf1237)
- chore: ... (c6f2504)
- Default provider is now Ollama (local) — Claude and Voyage AI are optional upgrades
- Memory source now reflects actual model name instead of hardcoded `claude`
- Init no longer triggers tool calls — memories injected server-side
- Tokens stream live for all models — client discards during reasoning if toggle is on

---

## [0.1.0] — Initial release

### Added
- Persistent memory with 7 structured types
- Semantic search via pgvector + Voyage AI embeddings
- MCP server with 11 tools
- Anthropic Claude support (Haiku, Sonnet, Opus)
- Ollama support for local models
- Real-time streaming via WebSocket
- 4 themes — Light, Dark, Aurora, System
- Auto-deduplication background job
- Brain export (JSON)
- Cursor / Windsurf MCP integration
- Terminal chat client
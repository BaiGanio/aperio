# Skills System

Skills are modular agent instructions stored in `skills/<name>/SKILL.md`. ~30+ skills.

Skills are loaded on demand. The `skills/` directory is a flat list; test files live in `tests/skills/`.

## Skill Categories

### Agent behavior
`agent-conduct`, `reasoning-planning`, `conversation-lifecycle`, `memory-protocol`,
`tool-integration`, `debugging-and-error-recovery`, `handoff`

### Code
`coding-standards`, `coding-examples` (redirect to coding-standards),
`code-review-and-quality`, `code-simplification`,
`test-driven-development`, `security-and-hardening`, `codegraph`

### Documents / Files
`pdf`, `docx`, `docx-advanced`, `pptx`, `xlsx`, `doc-coauthoring`, `docgraph`,
`preprocess-pdf`, `preprocess-image`, `working-with-files`

### UI / Design
`canvas-design`, `design-randomizer`, `frontend-design`, `theme-factory`, `webapp-testing`

### Meta
`skill-creator`, `autotune`, `mcp-builder`, `prompt-optimizer`, `wiki`

## Portable agent rules

Skills only reach agents running *inside* Aperio. For agents on other hosts that
connect over MCP, the same discipline ships as a canonical ruleset plus generated
per-platform adapters — the distribution pattern borrowed from
[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT), #285 WS3.

| | |
|---|---|
| Canonical source | `id/agent-rules/aperio-memory.md` — hand-written, ≤80 lines |
| Generated adapters | `integrations/agent-rules/AGENTS.snippet.md` (generic), `cursor/aperio-memory.mdc`, `claude-code/aperio-memory/SKILL.md` |
| Regenerate | `npm run gen:agent-rules` |
| Drift gate | `npm run gen:agent-rules:check`, enforced by `ci.generated-artifacts.yml` |

The adapters are generated artifacts — never hand-edit one; change the canonical
file and regenerate. The ruleset covers the *judgment* half of memory use (when
the preload is not enough, `remember` vs `propose_memory`, correcting rather than
duplicating, what must never be stored); the in-repo `memory-protocol` skill keeps
the tool API and SQL detail and cross-links to it.

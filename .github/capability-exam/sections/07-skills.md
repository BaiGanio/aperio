# §7 — Skill triggering

Does the right skill load? Wording is chosen to hit each skill's keywords.

> Run per the loop in exam.md: announce, ask **"Run it? (yes / no)"**, act on yes, then
> confirm the named skill shows in the "🎯 Skills matched" chip. Checkpoint after each.
> Fetch `08-chains.md` when done.

| # | Prompt | ✅ Skill expected |
|---|--------|------------------|
| 7.1 | `Create a PowerPoint pitch deck with 5 slides about the Nimbus service.` | `pptx` |
| 7.2 | `Open the spreadsheet in my downloads and add a column with computed totals.` | `xlsx` |
| 7.3 | `I need to edit an existing Word document — add tracked changes and a comment.` | `docx-advanced` (+ `docx`) |
| 7.4 | `Merge these two PDF files and add a watermark to every page.` | `pdf` |
| 7.5 | `Design a minimal poster as a PNG using good visual design philosophy.` | `canvas-design` |
| 7.6 | `Build a styled React dashboard landing page with a custom color theme.` | `theme-factory` |
| 7.7 | `Help me co-author a design doc / technical spec for the pricing API.` | `doc-coauthoring` |
| 7.8 | `I have a rough half-formed idea — help me structure this into a proper prompt.` | `prompt-optimizer` |
| 7.9 | `This is a complex multi-step task with dependencies — plan first, then execute.` | `reasoning-planning` |
| 7.10 | `Review this Go code for naming conventions and error handling style.` | `coding-standards` |
| 7.11 | `I want to create a new skill from scratch and run an eval to benchmark it.` | `skill-creator` |
| 7.12 | `Guide me on building MCP servers to integrate external services and APIs using the MCP SDK.` | `mcp-builder` |
| 7.13 | `Run a Playwright browser test and screenshot the app's frontend.` | `webapp-testing` |
| 7.14 | `Save this as a preference and remember my correction for future context.` | `memory-protocol` |
| 7.15 | `Find where a function is defined and what calls it in this indexed repo.` | `codegraph` |
| 7.16 | `Chain these two tool calls with a retry and fallback on failure.` | `tool-integration` |
| 7.17 | `The context window is filling up — do a handoff so a fresh agent can continue.` | `handoff` |

**Reading the results:**

- Always-on skills (`agent-conduct`, `conversation-lifecycle`) load every turn and won't appear as "matched".
- `coding-examples` and `memory-learning` are merged stubs marked `load: never`; the matcher filters them out, so they must **never** appear in the chip — if they do, that's a regression (guarded by `tests/skills/skills.test.js → "load: never stubs are never matched"`).
- **Co-loading:** some prompts naturally trigger multiple related skills. Known co-loads: `docx-advanced` pulls `docx` (7.3), `pdf` may pull `preprocess-pdf` (7.4), `theme-factory` may pull `canvas-design` (7.6), `reasoning-planning` may pull `tool-integration` (7.9), `handoff` may pull `memory-protocol` and `wiki` (7.17). The intended skill should appear first.
- **Negative test — load:never stubs.** As an extra drill, run `Show me some coding examples and explain memory learning.` Neither `coding-examples` nor `memory-learning` should appear in the chip. If either does, the `load: never` filter has regressed.

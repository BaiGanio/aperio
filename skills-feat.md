# Skills Feature Comparison — Anthropic Skill Set vs. Aperio

**Question being answered:** Of the 17 skills in the official Anthropic skill set (screenshot),
which are *useful* for Aperio, which are *not*, which *overlap* with what we already ship,
and which could *extend / improve* an existing Aperio skill?

**Framing — what Aperio actually is (this drives every verdict below):**
- A **local-first personal memory layer**: SQLite/Postgres + MCP + Ollama, runs **local models**
  (deepseek, LLaVA, Qwen, etc.) with optional cloud providers (Anthropic, DeepSeek, Gemini).
- Surfaces: a **web UI** (streaming chat, themes, code panel) and an **MCP server** consumed by
  external clients (Cursor, Windsurf, Claude).
- Strengths: memory, wiki, code graph, file/document tooling, agent loop.
- It is **not** a corporate/Slack/Claude.ai-artifact environment. Skills that assume that
  context are low value here regardless of their quality.

> The official set is built for **Claude.ai + the Anthropic artifacts runtime**. Aperio is a
> self-hosted tool for individuals running local models. "Good skill" ≠ "good for Aperio."

---

## TL;DR verdict table

| # | Anthropic skill | Verdict for Aperio | Maps to / action |
|---|-----------------|--------------------|------------------|
| 1 | **docx** | ⭐ **Add — top gap** | We ship xlsx/pptx/pdf but **no docx skill**, despite already bundling `xlsx/scripts/office/validators/docx.py`. Biggest hole in our document suite. |
| 2 | **skill-creator** | ⭐ **Add (adapt)** | We have a skill *system* but no skill to author one. Pairs with our `mcp-builder` + `prompt-optimizer`. |
| 3 | **webapp-testing** | ✅ Add — dev-facing | Aperio *is* a webapp; Playwright-driven testing helps us, not end users. Internal tooling, not a user skill. |
| 4 | **doc-coauthoring** | 🔀 **Mix into** `working-with-files` | Turn-based document collaboration patterns extend our surgical-edit skill. |
| 5 | **frontend-design** | 🔀 Extend `theme-factory` | Useful *only* if we render HTML artifacts in the web UI. Folds into theming. |
| 6 | **web-artifacts-builder** | 🔀 Conditional | Same gate as above — needs an artifact render surface. Strong if we build one. |
| 7 | **canvas-design** | 🔀 Conditional / merge | Overlaps frontend-design + theme-factory; only one artifact-design skill is worth keeping. |
| 8 | **algorithmic-art** | ➖ Niche / optional | Fun, low priority. Generative art has no tie to a memory tool's core use. |
| 9 | **claude-api** | ➖ Low (we're local-first) | Anthropic-specific reference. We already ship a harness `claude-api` skill; in-app it's marginal since users run local/multi-provider. |
| 10 | **brand-guidelines** | ❌ Skip | Corporate brand-asset workflow. No fit for a personal memory layer. |
| 11 | **internal-comms** | ❌ Skip | Company-announcement writing. Out of scope. |
| 12 | **slack-gif-creator** | ❌ Skip | Pure Slack/novelty. Zero relevance. |
| 13 | **mcp-builder** | ♻️ **Already shipped** | Compare versions — pull upstream improvements. |
| 14 | **pdf** | ♻️ **Already shipped** | Same — diff against upstream. |
| 15 | **pptx** | ♻️ **Already shipped** | Same. |
| 16 | **theme-factory** | ♻️ **Already shipped** | Same (currently modified in our tree). |
| 17 | **xlsx** | ♻️ **Already shipped** | Same. Note our `office/` scripts already cover docx plumbing. |

Legend: ⭐ high-value add · ✅ add (narrow) · 🔀 extend/merge an existing skill · ➖ optional/low ·
❌ skip · ♻️ already vendored.

---

## 1. Clear gaps worth filling

### docx — **the single most obvious gap**
We have a complete-feeling Office story (`xlsx`, `pptx`, `pdf`) with one glaring hole: **Word documents**.
- FEATURES lists a DOCX *attachment handler* (read-only) but **no generation/editing skill**.
- We already vendor `skills/xlsx/scripts/office/validators/docx.py` + the `soffice/unpack/pack`
  pipeline — the hard plumbing is *already in the repo*. A `docx` skill would mostly wire it up.
- This is what makes the user's instinct ("not quite enough / complete") correct: a memory/agent
  tool that can produce spreadsheets and slide decks but not letters, reports, or contracts feels
  incomplete.
- **Action:** vendor the upstream `docx` skill, repoint it at our existing `office/` scripts, and
  add a `generate_docx` path analogous to `generate_xlsx`.

### skill-creator — **author skills from inside Aperio**
Aperio has a real skill system (`skills/` matched per turn) but no guided way to *create* one.
- Complements existing `mcp-builder` (build a tool) + `prompt-optimizer` (shape an idea).
- Lets power users extend their own local agent — very on-brand for a self-hosted tool.
- **Action:** adapt upstream `skill-creator` to Aperio's frontmatter conventions (our skills use
  `metadata.keywords / category / load`, which the stock one doesn't know about).

### webapp-testing — **for us, not for users**
Aperio is itself a streaming web app with a growing UI (themes, code panel, i18n, switches).
- A Playwright-based `webapp-testing` skill is valuable for **our own dev/CI**, alongside the
  existing 723-test suite — *not* something to expose to end users.
- **Action:** keep as an internal/dev skill or a `/run`-style helper, not a user-matched skill.

---

## 2. Extend or merge into existing skills (don't add standalone)

### doc-coauthoring → fold into `working-with-files`
Our `working-with-files` covers *surgical* edits to non-code docs. `doc-coauthoring` adds the
*collaboration* layer (track-changes thinking, propose-vs-apply, section ownership). Best absorbed
as a section there rather than a competing skill.

### frontend-design / web-artifacts-builder / canvas-design → one artifact-design skill, gated on rendering
These three overlap heavily (HTML/CSS design, building web artifacts, visual canvas layout).
- They only pay off **if Aperio renders artifacts** in the web UI. Today `theme-factory` already
  styles "HTML landing pages, slides, docs, reports," so the *theming* half exists.
- **Recommendation:** do **not** add all three. If we build an artifact render surface, vendor
  **one** (`web-artifacts-builder` is the most general) and let `theme-factory` supply the styling.
  Otherwise defer — a memory tool gains little from artifact builders with nowhere to show them.

### algorithmic-art → optional companion to theme-factory
If an artifact surface lands, generative-art helpers are a nice-to-have for backgrounds/visuals.
Low priority; no standalone justification.

---

## 3. Already shipped — reconcile with upstream (don't re-add)

`mcp-builder`, `pdf`, `pptx`, `theme-factory`, `xlsx` are **already in `skills/`**.
- Action is **not** "add" — it's **diff against the current upstream versions** and pull in fixes
  the public set has accumulated.
- `theme-factory` is currently modified in our working tree (`git status`), so check that local
  changes aren't clobbered and aren't drifting from upstream by accident.
- `xlsx` already carries the shared `office/` toolchain that a future `docx` skill should reuse —
  keep that dependency centralized rather than duplicating it.

---

## 4. Skip for Aperio (good skills, wrong product)

| Skill | Why it doesn't fit |
|-------|--------------------|
| **brand-guidelines** | Assumes a company brand kit + asset pipeline. Aperio is personal/local. |
| **internal-comms** | Writes org announcements/newsletters. No audience in a single-user memory tool. |
| **slack-gif-creator** | Slack-specific novelty output. Irrelevant to the product. |
| **claude-api** | Anthropic-only reference, and we're deliberately multi-provider/local-first. We already get a `claude-api` reference via the harness; baking it into the app pushes users toward one cloud vendor against Aperio's privacy stance. |

---

## 5. Gap analysis — what Aperio's *own* set is missing

Comparing both lists, the official set is **document/artifact-output heavy**; Aperio is
**memory/reasoning/process heavy**. The asymmetry is the answer to "are our skills complete?":

- **Output completeness gap:** add **docx** (and only-if-rendering: one artifact builder).
  This is the real fix for "not quite enough."
- **Authoring gap:** add **skill-creator** so the skill system is self-extending.
- **Everything else** the official set offers is either already shipped, mergeable into an existing
  skill, or off-product. Aperio is *not* broadly behind — it's specifically missing **docx** and
  **skill-creator**, plus the optional artifact track.

What Aperio has that the official set does **not** (don't lose sight of our strengths):
`codegraph`, `memory-learning` / `memory-protocol`, `wiki`, `reasoning-planning`,
`conversation-lifecycle`, `handoff`, `agent-conduct`, `preprocess-image` / `preprocess-pdf`
(local-VLM specific), `coding-standards` / `coding-examples`. These are the differentiators a
local memory layer should lead with.

---

## 6. Recommended priority

1. **docx skill** — fills the document suite; plumbing already vendored. *(High, low effort.)*
2. **skill-creator** (Aperio-adapted) — makes the skill system self-serve. *(High, medium effort.)*
3. **Reconcile the 5 vendored skills** with upstream; protect local `theme-factory` edits. *(Med.)*
4. **doc-coauthoring → merge** into `working-with-files`. *(Med, low effort.)*
5. **webapp-testing** as an internal dev skill. *(Med, dev-only.)*
6. **Artifact track** (`web-artifacts-builder` + `theme-factory`, optional `algorithmic-art`/
   `canvas-design`/`frontend-design`) — **only if** we add a render surface. *(Deferred / gated.)*
7. **Skip:** `brand-guidelines`, `internal-comms`, `slack-gif-creator`, in-app `claude-api`.

---

*Note: this is a comparison/recommendation doc, not an implementation. The docx "plumbing already
exists" claim is based on `skills/xlsx/scripts/office/validators/docx.py` and the `office/` pack/
unpack/soffice scripts being present in the repo — worth a quick verification before scoping the work.*

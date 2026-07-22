---
name: pptx
description: "Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file (even if the extracted content will be used elsewhere, like in an email or summary); editing, modifying, or updating existing presentations; combining or splitting slide files; working with templates, layouts, speaker notes, or comments. Trigger whenever the user mentions \"deck,\" \"slides,\" \"presentation,\" or references a .pptx filename, regardless of what they plan to do with the content afterward. If a .pptx file needs to be opened, created, or touched, use this skill."
license: Proprietary. LICENSE.txt has complete terms
metadata:
  keywords: "pptx, presentation, slides, slide deck, powerpoint, pitch deck, deck, slideshow, pptxgenjs"
  category: "file-generation"
  load: "on-demand"
---

# PPTX Skill

## Creation Execution Contract

Creating a presentation always starts with `write_file`, not `run_node_script`:

1. Write a task-specific PptxGenJS builder (for example, `<session-workspace>/create-deck.js`) into the session workspace.
2. Only after that write succeeds, call `run_node_script` with the exact builder path you just wrote.
3. Run the existing `skills/pptx/scripts/verify.js` and `skills/pptx/scripts/read.js` helpers against the output.

The bundled `scripts/` directory contains read/edit/pack/QA helpers, not a general presentation generator. Never guess a helper filename and never create or overwrite files under `skills/`; creation code belongs in the session workspace.

## Quick Reference

| Task | Guide |
|------|-------|
| Read/analyze content | `node scripts/read.js presentation.pptx` |
| Edit or create from template | Read [editing.md](editing.md) |
| Create from scratch | Read [pptxgenjs.md](pptxgenjs.md) |
| **Pick styling (required)** | Show swatches via **theme-factory** and confirm before building |
| **Verify output (required)** | `node scripts/verify.js output.pptx` |

---

## Reading Content

```bash
# Text extraction
node scripts/read.js presentation.pptx

# Visual overview
node scripts/thumbnail.js presentation.pptx

# Raw XML (unpack for editing)
node scripts/unpack.js presentation.pptx unpacked/
```

---

## Editing Workflow

**Read [editing.md](editing.md) for full details.**

1. Analyze template with `node scripts/thumbnail.js`
2. Unpack → manipulate slides → edit content → clean → pack

---

## Creating from Scratch

**⚠️ MANDATORY: Read [pptxgenjs.md](pptxgenjs.md) before writing any code.** The companion file contains the exact API surface for the installed version. Do NOT guess PptxGenJS method names from training data — LLMs commonly hallucinate non-existent methods like `setSlideSize()`, `getSlides()`, `getBackground()`, `shapes.rectangle`, `getPr()`, and `getCTMer()`. These will crash at runtime. The companion file lists only methods that actually work. If you haven't read it, you haven't started.

Use when no template or reference presentation is available.

**Pick the theme with the user before writing code (required).** Do not silently choose your own colors, and do **not** just list palette names or hex codes as text — the user must *see* the actual colors. The **theme-factory** skill (its `themes/` directory) is the single source of truth for available themes. Use its show-and-confirm flow:

1. **Render the swatch image into this session's workspace** so the chat can display it. Run, via `run_node_script`:
   `node skills/theme-factory/scripts/swatches.js <session-workspace>/swatches.png`
   (substitute the absolute session workspace path given under "Session workspace"). The script writes a PNG showing every theme's real colors and prints its path.
2. **Display the swatch image inline** by emitting a markdown image pointing at the `/scratch` URL for that file, e.g. `![Theme swatches](/scratch/<session-id>/swatches.png)`. This renders the colors in the chat. (A plain text list is not acceptable.)
3. **Ask which theme to apply** and recommend one that fits the topic (e.g. *Midnight Galaxy* or *Tech Innovation* for a dark, premium deck).
4. **Wait for the user's choice** before generating any slides.
5. Read the chosen theme's file from `skills/theme-factory/themes/` and apply its hex codes and fonts throughout the deck via PptxGenJS.

**Only skip the swatch step when** the user already gave specific colors or brand hex codes — in that case state the palette you'll use and proceed. If none of the presets fit, generate a custom theme, show it for review, and apply it once confirmed.

---

## Design Ideas

**Don't create boring slides.** Plain bullets on a white background won't impress anyone. Consider ideas from this list for each slide.

### Before Starting

- **Pick a bold, content-informed color palette**: The palette should feel designed for THIS topic. If swapping your colors into a completely different presentation would still "work," you haven't made specific enough choices.
- **Dominance over equality**: One color should dominate (60-70% visual weight), with 1-2 supporting tones and one sharp accent. Never give all colors equal weight.
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a visual motif**: Pick ONE distinctive element and repeat it — rounded image frames, icons in colored circles, thick single-side borders. Carry it across every slide.

### Color Palettes

Don't pick colors here from memory or default to generic blue. The themes live in the **theme-factory** skill (`skills/theme-factory/themes/`) — that is the source of truth. Follow the swatch show-and-confirm flow in [Creating from Scratch](#creating-from-scratch) to surface the real colors to the user and apply the chosen theme. Only invent a custom palette when no preset fits, and even then show it for review first.

### For Each Slide

**Every slide needs a visual element** — image, chart, icon, or shape. Text-only slides are forgettable.

**Layout options:**
- Two-column (text left, illustration on right)
- Icon + text rows (icon in colored circle, bold header, description below)
- 2x2 or 2x3 grid (image on one side, grid of content blocks on other)
- Half-bleed image (full left or right side) with content overlay

**Data display:**
- Large stat callouts (big numbers 60-72pt with small labels below)
- Comparison columns (before/after, pros/cons, side-by-side options)
- Timeline or process flow (numbered steps, arrows)

**Visual polish:**
- Icons in small colored circles next to section headers
- Italic accent text for key stats or taglines

### Typography

**Choose an interesting font pairing** — don't default to Arial. Pick a header font with personality and pair it with a clean body font.

| Header Font | Body Font |
|-------------|-----------|
| Georgia | Calibri |
| Arial Black | Arial |
| Calibri | Calibri Light |
| Cambria | Calibri |
| Trebuchet MS | Calibri |
| Impact | Arial |
| Palatino | Garamond |
| Consolas | Calibri |

| Element | Size |
|---------|------|
| Slide title | 36-44pt bold |
| Section header | 20-24pt bold |
| Body text | 14-16pt |
| Captions | 10-12pt muted |

### Spacing

- 0.5" minimum margins
- 0.3-0.5" between content blocks
- Leave breathing room—don't fill every inch

### Avoid (Common Mistakes)

- **Don't repeat the same layout** — vary columns, cards, and callouts across slides
- **Don't center body text** — left-align paragraphs and lists; center only titles
- **Don't skimp on size contrast** — titles need 36pt+ to stand out from 14-16pt body
- **Don't default to blue** — pick colors that reflect the specific topic
- **Don't mix spacing randomly** — choose 0.3" or 0.5" gaps and use consistently
- **Don't style one slide and leave the rest plain** — commit fully or keep it simple throughout
- **Don't create text-only slides** — add images, icons, charts, or visual elements; avoid plain title + bullets
- **Don't forget text box padding** — when aligning lines or shapes with text edges, set `margin: 0` on the text box or offset the shape to account for padding
- **Don't use low-contrast elements** — icons AND text need strong contrast against the background; avoid light text on light backgrounds or dark text on dark backgrounds
- **NEVER use accent lines under titles** — these are a hallmark of AI-generated slides; use whitespace or background color instead

---

## QA (Required)

**Assume there are problems. Your job is to find them.**

QA has two layers. **Always required** (pure Node, works on every OS): `verify.js` (structural gate) + `read.js` (content check). **When available** (needs LibreOffice + poppler, run via `run_shell`): the visual render pass. Never block declaring success on the visual pass when those binaries are absent.

Your first render is almost never correct. Approach QA as a bug hunt, not a confirmation step. If you found zero issues on first inspection, you weren't looking hard enough.

### Verification before declaring success (MANDATORY)

Do **not** tell the user a `.pptx` was created until you have run the verifier and seen the success marker:

```bash
node scripts/verify.js /absolute/path/to/output.pptx
```

What to require before claiming success:

1. The tool result begins with `✅ Exit 0`. Any `❌ Exit` or stderr containing `PPTX_ERROR:` means the run failed — report the error to the user verbatim instead of pretending it worked.
2. The verifier's stdout contains an `APERIO_PPTX:` line with the absolute path and byte size of the produced file. **No marker = no success.** The host will independently stat the file; if it is missing, the tool result will be rewritten to a hard `❌ ... file does NOT exist on disk` and you must surface that to the user.
3. `slides` in the marker is the number you actually intended, and `placeholders` is 0 (otherwise leftover boilerplate is still in the deck).

If any of these checks fail, fix the underlying problem and rerun — never paper over it with a generic "Done!" message.

**Presenting the result:** when the deck lives in the session workspace, the app automatically shows a download button for it — do **not** tell the user to "download from the scratch folder" or navigate the filesystem. Just confirm the deck is ready; the download card handles the rest.

All skill scripts now print a `PPTX_ERROR:{...}` JSON line on stderr when they crash. Read it; it contains the failing script, the error message, the error code, and the stack.


### Content QA

```bash
node scripts/read.js output.pptx
```

Check for missing content, typos, wrong order.

**When using templates, check for leftover placeholder text.** With `run_shell` enabled you can pipe the extracted text straight through grep (use the absolute path to `read.js`; the deck is resolved relative to the session workspace cwd):

```bash
node /absolute/path/to/skills/pptx/scripts/read.js output.pptx | grep -iE "xxxx|lorem|ipsum|this.*(page|slide).*layout"
```

If grep returns results, fix them before declaring success. (If `run_shell` is disabled, run `read.js` via `run_node_script` and scan the output yourself.)

### Visual QA (when available)

Visual QA renders the deck to images via LibreOffice (`soffice`) + poppler (`pdftoppm`), run through `run_shell`. These are **optional system dependencies** — not every machine has them. If `node scripts/thumbnail.js` prints a `skipped` marker (`"skipped":true`, exit 0), or `run_shell` reports the binary was **not found** (`⚠️ Command not found`), visual QA is unavailable on this machine. That is **not a failure**: the deck was still generated and structurally verified. Report it to the user as "visual QA skipped — LibreOffice not installed" and treat the pure-Node `verify.js` + `read.js` checks as your QA. Then stop — do not retry the render.

When the binaries **are** present, do the full visual pass below.

**⚠️ USE SUBAGENTS** — even for 2-3 slides. You've been staring at the code and will see what you expect, not what's there. Subagents have fresh eyes.

Convert slides to images (see [Converting to Images](#converting-to-images)), then use this prompt:

```
Visually inspect these slides. Assume there are issues — find them.

Look for:
- Overlapping elements (text through shapes, lines through words, stacked elements)
- Text overflow or cut off at edges/box boundaries
- Decorative lines positioned for single-line text but title wrapped to two lines
- Source citations or footers colliding with content above
- Elements too close (< 0.3" gaps) or cards/sections nearly touching
- Uneven gaps (large empty area in one place, cramped in another)
- Insufficient margin from slide edges (< 0.5")
- Columns or similar elements not aligned consistently
- Low-contrast text (e.g., light gray text on cream-colored background)
- Low-contrast icons (e.g., dark icons on dark backgrounds without a contrasting circle)
- Text boxes too narrow causing excessive wrapping
- Leftover placeholder content

For each slide, list issues or areas of concern, even if minor.

Read and analyze these images:
1. /path/to/slide-01.jpg (Expected: [brief description])
2. /path/to/slide-02.jpg (Expected: [brief description])

Report ALL issues found, including minor ones.
```

### Verification Loop

1. Generate slides → Convert to images → Inspect
2. **List issues found** (if none found, look again more critically)
3. Fix issues
4. **Re-verify affected slides** — one fix often creates another problem
5. Repeat until a full pass reveals no new issues

**When visual QA is available, do not declare success until you've completed at least one fix-and-verify cycle.** When it is unavailable (binaries not installed), the required gate is a passing `verify.js` plus a `read.js` content check — declare success on those.

---

## Converting to Images

Convert presentations to individual slide images for visual inspection, using `run_shell` (one command per call). **Requires the optional LibreOffice + poppler binaries** — if either command returns `⚠️ Command not found`, they aren't installed; skip visual QA (see [Visual QA](#visual-qa-when-available)).

```bash
soffice --headless --convert-to pdf output.pptx
pdftoppm -jpeg -r 150 output.pdf slide
```

This creates `slide-01.jpg`, `slide-02.jpg`, etc.

To re-render specific slides after fixes:

```bash
pdftoppm -jpeg -r 150 -f N -l N output.pdf slide-fixed
```

---

## Dependencies

All Node.js packages are in the project's `package.json` (already installed) — import them by bare specifier (`import PptxGenJS from "pptxgenjs"`). Do not attempt to `npm install` from a generated script; resolution walks up from the script's directory to `aperio/node_modules`, so bare imports just work.

**Critical**: write generator scripts and the output `.pptx` **inside this session's scratch workspace** — its absolute path is given in the system prompt under "Session workspace" (`var/scratch/<session-id>/`). Files written there are retained with the session and cleaned up automatically when it expires. If no session workspace was provided (e.g. CLI usage), fall back to `skills/pptx/scratch/`. Either way the location must be **under the project root** — a script in `/tmp/` or anywhere outside it will fail with `ERR_MODULE_NOT_FOUND: Cannot find package 'pptxgenjs'` because Node's module resolution cannot reach `aperio/node_modules` from there.

- `pptxgenjs` — creating decks from scratch
- `adm-zip` — ZIP unpack/pack
- `fast-xml-parser` — XML parsing
- `sharp` — thumbnail image processing

Optional packages (install with `npm install <pkg>` from the Aperio root if a deck actually needs them — don't add them speculatively):
- `react`, `react-dom`, `react-icons` — only needed for the icon-rendering path

**Optional system CLIs — only needed for the visual QA render pass, invoked via `run_shell`.** Generation, `verify.js`, and `read.js` work without them. If absent, `run_shell` returns `⚠️ Command not found` (and `thumbnail.js` emits a `"skipped":true` marker) — not a failure; report visual QA as skipped and rely on the pure-Node checks.

| Binary | macOS | Debian/Ubuntu | Windows |
|--------|-------|---------------|---------|
| `soffice` (PPTX→PDF) | `brew install --cask libreoffice` | `apt install libreoffice` | installer at libreoffice.org |
| `pdftoppm` (PDF→images) | `brew install poppler` | `apt install poppler-utils` | poppler-windows release |

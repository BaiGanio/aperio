---
name: frontend-design
description: Build polished, responsive, accessible web interfaces and standalone HTML artifacts from plain-language requests. Use when asked to write, display, save, preview, or revise an HTML page or file; for websites, landing pages, dashboards, prototypes, interactive layouts; and for non-coders who need a result they can immediately view and refine visually.
metadata:
  keywords: "html file, html page, interactive html, web interface, landing page, website, frontend, dashboard"
  category: "design"
  load: "on-demand"
---

# Frontend Design

Create a working visual artifact, not a code explanation. Own the implementation, usability,
and feedback loop here; take the visual direction from whichever aesthetic skill is loaded.

## Companion Skills

- `design-randomizer` — commit to a design brief first when the user named no style. Skipping
  this is how every page ends up Inter + rounded cards + purple gradient.
- `theme-factory` — palettes and font pairings once a direction is chosen.
- `dataviz` — read before writing the first line of any chart, stat tile, or dashboard grid.
- `webapp-testing` — only when the user asks for real browser automation against a running app.

## Workflow

1. Infer the audience, primary task, content hierarchy, and required interactions. Ask only
   when a missing choice would materially change the result.
2. Choose one coherent visual direction. Preserve an existing design system when editing.
3. Build semantic, responsive, accessible markup, with useful empty and error states. The
   Quality Bar below is the checklist.
4. Make every visible interaction work. Do not ship decorative controls, dead links, placeholder
   copy presented as final content, or a page that depends on an unstated build step.
5. Deliver, then verify against the render.

## Artifact Contract

- Unless the user names a framework, deliver one self-contained standalone HTML document with
  CSS in `<style>` and JavaScript in `<script>` so it opens directly in a browser.
- Include `<!doctype html>`, UTF-8 metadata, a viewport declaration, a meaningful title, and
  properly closed markup.
- Return the complete document in one fenced `html` block. Aperio strips that block from the
  message, saves it to the workspace, and shows a card with Preview, Code, Open in browser,
  Show in folder, Copy, and Download.
- **Emit the whole document, every time** — including on revisions. Aperio only promotes a block
  to a saved artifact at 1000+ characters or 20+ lines; a fragment, diff, or excerpt stays inline
  as ordinary code with nothing the user can click.
- **`<title>` becomes the filename**, slugified (falling back to `index.html`). Title the page
  for the person who will later hunt for it in a folder.
- One document per reply. Each qualifying block becomes its own card, so a page split across
  several blocks arrives as several broken files.
- Keep explanation brief and put the usable artifact first. Do not make a non-coder search for
  generated files or reconstruct code from fragments.
- Prefer embedded or local assets. If remote assets are essential, explain that offline viewing
  will be incomplete and provide resilient fallbacks.

## Quality Bar

Non-negotiable, because the user is judging the render and cannot audit the markup:

- Body text at 4.5:1 contrast or better; never convey state by color alone.
- Visible `:focus-visible` styling on every interactive element; tab order follows reading order.
- Real landmarks and headings (`header`/`nav`/`main`/`footer`, one `h1`, no level skips);
  `alt` on every meaningful image, `aria-label` on icon-only buttons.
- No horizontal scroll on the body at 360px. Wide tables, code, and diagrams scroll inside
  their own `overflow-x: auto` container.
- Touch targets at least 44×44px.
- Honor `prefers-reduced-motion`; support `prefers-color-scheme` unless the design deliberately
  commits to a single look.
- Relative units and flex/grid over fixed pixel layouts; `max-width: 100%` on media.

## Visual Verification

Treat the rendered Preview as the source of truth, not the markup you just wrote. Check hierarchy,
interaction states, and narrow-screen behavior: no accidental blank region above the content, no
clipped text, no control whose purpose is unreadable. Refine before calling it finished.

On revision, change only what the user's visual feedback requires, keep the rest working, and say
in one line what changed.

## Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| No Preview card, just code in the chat | Block under the 1000-char / 20-line artifact threshold | Send the full document |
| File saved as `index.html` | Missing or empty `<title>` | Title the page |
| Several half-pages appear | Document split across multiple fenced blocks | One block, one document |
| Preview blank or unstyled | External CSS/JS/font that did not load | Inline it or embed as a `data:` URI |
| "Looks like every other AI site" | No design brief was committed to | Run `design-randomizer` before coding |

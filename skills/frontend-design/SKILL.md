---
name: frontend-design
description: Build polished, responsive, accessible web interfaces and standalone HTML artifacts from plain-language requests. Use when asked to write, display, save, preview, or revise an HTML page or file; for websites, landing pages, dashboards, prototypes, interactive layouts; and for non-coders who need a result they can immediately view and refine visually.
metadata:
  keywords: "html file, html page, interactive html, web interface, landing page, website, frontend, dashboard"
  category: "design"
  load: "on-demand"
---

# Frontend Design

Create a working visual artifact, not a code explanation. Let any loaded aesthetic
skill choose the visual direction; own the implementation, usability, and feedback loop here.

## Workflow

1. Infer the audience, primary task, content hierarchy, and required interactions. Ask only
   when a missing choice would materially change the result.
2. Choose one coherent visual direction. Preserve an existing design system when editing.
3. Build semantic, responsive, accessible markup with clear focus states, sufficient contrast,
   keyboard-operable controls, and useful empty/error states.
4. Make every visible interaction work. Do not ship decorative controls, dead links, placeholder
   copy presented as final content, or a page that depends on an unstated build step.
5. Deliver and inspect the rendered Preview. Use the visual feedback loop to check hierarchy,
   overflow, narrow-screen behavior, and interaction states; refine before calling it finished.

## Artifact Contract

- Unless the user names a framework, deliver one self-contained standalone HTML document with
  CSS in `<style>` and JavaScript in `<script>` so it opens directly in a browser.
- Include `<!doctype html>`, UTF-8 metadata, a viewport declaration, a meaningful title, and
  properly closed markup.
- Return the complete document in one fenced `html` block. Aperio persists that block and shows
  its Preview, Code, Open in browser, Show in folder, Copy, and Download affordances.
- Keep explanation brief and put the usable artifact first. Do not make a non-coder search for
  generated files or reconstruct code from fragments.
- Prefer embedded or local assets. If remote assets are essential, explain that offline viewing
  will be incomplete and provide resilient fallbacks.

## Visual Verification

Treat the rendered page as the source of truth. Confirm that content is visible without scrolling
past an accidental blank region, text does not clip, controls communicate their purpose, and the
layout remains usable at desktop and mobile widths. For revisions, preserve working behavior and
change only what the user's visual feedback requires.

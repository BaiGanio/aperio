# Aperio manual visual-system prototypes

Standalone review artifacts for [Choose the visual system through page prototypes](https://github.com/BaiGanio/aperio/issues/395). These files are a visual decision aid, not product documentation and not an implementation of the manual.

The experiment holds content and semantics constant while changing only the visual system. Each direction exercises the same four page archetypes:

1. entry and navigation;
2. task procedure, callouts, and code;
3. platform lanes and an annotated screenshot treatment; and
4. dense reference, a diagram, and mascot guidance.

## Directions

- **Signal Desk** - bright and spacious, with a technical grid, crisp aurora signals, and restrained radio-console controls. The default recommendation for clarity and longevity.
- **Night Receiver** - a more atmospheric violet receiver room. It gives Aperio the strongest immediate character, but uses dark ink selectively so ordinary pages remain printable.
- **Field Console** - warm service-manual paper, bolder labels, and tactile instrument-panel details. It has the strongest retro-radio character and the least resemblance to a software brochure.

Open the generated HTML previews directly:

- `preview-signal-desk.html`
- `preview-night-receiver.html`
- `preview-field-console.html`

Each HTML file remains usable as a responsive web prototype. The same semantic HTML is printed through Chromium's tagged-PDF API in both A4 and Letter sizes.

## Review prompts

- Which direction feels unmistakably Aperio without making long reading sessions tiring?
- Is the radio character structural enough, or too literal?
- Which hierarchy makes it fastest to find the next action, the success state, and recovery?
- Does the mascot feel like a selective guide rather than decoration?
- Which treatments should be mixed, if no whole direction wins?

## Build and verify

Requirements match the approved publishing proof: Pandoc, the repository's Playwright and Chromium installation, and Poppler.

```bash
PANDOC_BIN=/path/to/pandoc ./build.sh
./verify.sh
node ./check-screen.mjs
```

Generated PDFs are written to `output/pdf/`. Visual-QA PNGs are written to `tmp/pdfs/manual-visual-system/` and are intentionally not part of the prototype source.

## Approval boundary

Human review is required before any direction, token, font, component, mascot role, or illustration treatment is integrated into product documentation. This ticket stays open until that review explicitly approves a direction.

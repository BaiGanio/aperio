# Accessible PDF publishing pipeline proof

This is the standalone prototype produced for [Prove the accessible PDF publishing pipeline](https://github.com/BaiGanio/aperio/issues/394). It is not integrated into Aperio's documentation or release build.

The [approved decision](https://github.com/BaiGanio/aperio/issues/394#issuecomment-5279416078) establishes the technical direction: reviewed Markdown becomes semantic HTML5, and the same HTML becomes tagged A4 and Letter PDFs through Chromium. Approval is technical and structural only. The restrained sample styling is intentionally provisional; it does not approve or replace the later Aperio aurora theme, mascot treatment, illustration system, or final page archetypes.

## Candidate pipeline

```text
Pandoc Markdown
  -> Pandoc 3.10.1 semantic HTML5
    -> web edition (same HTML + screen CSS)
    -> Chromium DevTools print API (Playwright 1.62.1)
       -> A4 PDF
       -> Letter PDF
```

The renderer explicitly requests both `generateTaggedPDF` and `generateDocumentOutline`. Semantic HTML is the accessibility-bearing intermediate and the future web artifact; paged-media CSS owns paper geometry and print presentation.

## What the proof establishes

The checked-in artifacts demonstrate that this route can produce:

- a PDF structure tree with document language and marked-content metadata;
- heading outlines/bookmarks and internal destinations;
- selectable, searchable text in reading order;
- external link annotations;
- table, heading, list, code, and figure structures;
- meaningful alternative text on the vector figure;
- repeated table headers and stable running page furniture; and
- clean A4 and Letter renders from one semantic HTML artifact.

The visual review covered every rendered page in both paper sizes. The automated checks cover HTML landmarks and language, PDF tags, structure roles, figure alternative text, links, destinations, text extraction, page geometry, document language, marked status, and the expected outline.

## Build

Requirements:

- Pandoc `3.10.1`, available as a command
- The repo's pinned Playwright `1.62.1` and installed Chromium browser
- Poppler (`pdfinfo`, `pdftotext`, and `pdftoppm`) for verification
- Optional: Python plus `pypdf` for deeper outline and language-object inspection

Run:

```bash
PANDOC_BIN=/path/to/pandoc ./build.sh
./verify.sh
PYPDF_PYTHON=/path/to/python ./verify.sh
```

Generated files live in `artifacts/`; rendered PNGs live in `tmp/rendered/` and are QA-only.

`build.sh` recreates the semantic HTML, both PDFs, and all QA page renders. It removes stale page PNGs before rendering so a reduced page count cannot leave false evidence behind. `verify.sh` always runs the Poppler-backed structural checks; setting `PYPDF_PYTHON` adds the deeper catalog, language, structure-tree, and outline assertions.

The proof was accepted with:

- Pandoc `3.10.1`;
- Playwright `1.62.1` using Chrome for Testing `151.0.7922.34`;
- tagged PDF output from Chromium's DevTools `Page.printToPDF`; and
- Poppler plus pypdf `6.0.0` for inspection.

Renderer upgrades require rebuilding both paper sizes and repeating structural and full-page visual verification. Chromium and browser-like renderers can change pagination or tag output between versions.

## Known limitations

- This prototype does not claim formal PDF/UA conformance. A production release gate still needs a specialist validator and assistive-technology spot checks.
- Chromium emitted a nonstandard `/Strong` structure role for semantic `<strong>` in the initial proof. The accepted sample uses a styled neutral span for that emphasis until the production validator and renderer contract settle the behavior. Keep this as a regression case rather than generalizing the workaround silently.
- The sample proves a visual system can survive A4 and Letter pagination; it is not the Aperio manual's visual-system proposal.
- Reproducible dependency acquisition, hermetic fonts, CI packaging, release naming, and artifact retention remain decisions for the on-demand build and release-gate tickets.
- The Markdown sample exercises representative semantics, not the full manual's eventual page-archetype inventory.

## Decision boundary

This prototype answers whether the route is technically credible. It does not author or publish the manual.

The active [manual production-specification map](https://github.com/BaiGanio/aperio/issues/391) retains these decisions:

- [Choose the visual system through page prototypes](https://github.com/BaiGanio/aperio/issues/395) owns the aurora theme, typography, final page archetypes, and visual character.
- [Define screenshot, diagram, mascot, and asset lifecycle](https://github.com/BaiGanio/aperio/issues/401) owns mascot use, illustrations, screenshots, diagrams, and asset governance.
- [Decide authored, generated, and linked content boundaries](https://github.com/BaiGanio/aperio/issues/402) owns which material enters this pipeline and how canonical sources remain authoritative.
- [Define the on-demand manual build and reproducibility contract](https://github.com/BaiGanio/aperio/issues/403) owns dependency pinning and the production build interface.
- [Define verification, versioning, release, and maintenance gates](https://github.com/BaiGanio/aperio/issues/398) owns validators, accessibility checks, release acceptance, and long-term maintenance.

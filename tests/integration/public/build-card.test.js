import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { STREAMING_SCRIPTS } from "../../helpers/streamingScripts.js";

// The streaming modules are classic scripts built on shared browser globals, and
// the project has no DOM test library, so these are source-level invariants over
// the exact files loaded by public/index.html. Each one encodes a bug that
// actually shipped: a build card that froze mid-generation, and one that could
// never offer open-in-browser / show-in-folder.
const source = STREAMING_SCRIPTS.map(file => readFileSync(resolve(file), "utf8")).join("\n");
const indexSource = readFileSync(resolve("public/index.html"), "utf8");
const css = readFileSync(resolve("public/styles/messages/misc.css"), "utf8");
const indicatorCss = readFileSync(resolve("public/styles/tool-and-thinking-indicators.css"), "utf8");
const badgeSource = readFileSync(resolve("public/scripts/streaming/badges.js"), "utf8");
const renderingSource = readFileSync(resolve("public/scripts/rendering.js"), "utf8");
const spreadsheetSource = readFileSync(resolve("public/scripts/spreadsheet-preview.js"), "utf8");
const attachmentCss = readFileSync(resolve("public/styles/msg-attachments.css"), "utf8");
const turnSource = readFileSync(resolve("public/scripts/streaming/events/turn.js"), "utf8");
const chatSource = readFileSync(resolve("public/scripts/chat.js"), "utf8");
const markdownSource = readFileSync(resolve("public/scripts/markdown.js"), "utf8");
const knowledgeSource = readFileSync(resolve("public/scripts/streaming/events/knowledge.js"), "utf8");

test("build-card invariants cover the streaming assets loaded by the app shell", () => {
  assert.match(indexSource, /scripts\/streaming\/state\.js/);
  assert.match(indexSource, /scripts\/streaming\/handler\.js/);
  assert.match(indexSource, /scripts\/streaming\/deliverables\.js/);
  assert.doesNotMatch(indexSource, /scripts\/streaming\.js/);
});

test("the streaming cursor is a reused node, never re-created per frame", () => {
  // A fresh cursor node every token restarts its CSS animation from 0%, so it
  // never completes a cycle and renders permanently frozen mid-travel.
  assert.doesNotMatch(source, /insertAdjacentHTML\([^)]*class="cursor"/);
  assert.match(source, /function _streamShell\(/);
  assert.match(source, /querySelector\(":scope > \.cursor"\)/);
});

test("the streaming cursor travels rather than blinking in place", () => {
  // A blink reads as an idle caret: during a long build, where the source is
  // stripped out and nothing else moves, it could not distinguish working from
  // hung. Travel can't look stalled without being stalled.
  assert.match(source, /const CURSOR_DOTS = "<i><\/i><i><\/i><i><\/i>"/);
  // Both construction sites must use it, or one path renders an empty span.
  assert.doesNotMatch(source, /class="cursor">▋/);
  assert.doesNotMatch(source, /cursor\.textContent = "▋"/);
  assert.match(indicatorCss, /@keyframes comet-travel/);
  assert.match(indicatorCss, /\.cursor i \{/);
  // Motion is the signal, so reduced-motion slows it — never stops it.
  assert.match(indicatorCss, /prefers-reduced-motion[\s\S]*\.cursor i \{ animation-duration/);
});

test("streaming markdown does not clobber the whole bubble", () => {
  // bubble.innerHTML = … during streaming would take the cursor and the build
  // cards with it. The markdown gets its own container instead.
  assert.match(source, /textEl\.className = "stream-text"/);
  assert.match(source, /textEl\.innerHTML = markup/);
});

test("build cards are reconciled in place so their spinner keeps running", () => {
  assert.match(source, /function _syncDeliverableCards\(/);
  assert.match(source, /_renderDeliverableCard\(existing\[i\], file, building/);
});

test("a building card reports progress rather than a static placeholder", () => {
  assert.match(source, /build-card-spinner/);
  assert.match(source, /building… \$\{_formatBuildSize\(file\.content\)\}/);
  assert.match(css, /\.build-card-spinner\s*\{/);
  // The spinner is rendered as an inline span — its CSS animation comes from
  // the generic @keyframes spin in tool-and-thinking-indicators.css.
  assert.match(indicatorCss, /@keyframes spin\b/);
});

test("the build progress bar is toggled, not rebuilt, and only shows while building", () => {
  // The byte counter ticks too slowly to read as motion, but toggling the bar's
  // hidden property keeps it from being rebuilt per frame (which would restart
  // any CSS animation from 0%).
  assert.match(source, /querySelector\("\.build-card-progress"\)\.hidden = !building/);
  assert.match(source, /class="build-card-progress" hidden/);
  assert.match(css, /\.build-card-progress\s*\{/);
});

test("open-in-browser and show-in-folder appear only where the modal can't carry them", () => {
  assert.match(source, /bi-box-arrow-up-right/);
  assert.match(source, /bi-folder2-open/);
  assert.match(source, /fetch\("\/api\/artifact\/reveal"/);
  // Both need a real workspace URL — they have no file to point at when the
  // deliverable exists only as an in-memory string. Previewable files get them
  // from the preview modal instead, so repeating them on the card is noise.
  assert.match(source, /if \(url && !previewable\) \{/);
  assert.match(source, /const previewable = \/\\\.html\?\$\/i\.test\(displayName\)/);
});

test("the preview action forwards the artifact URL to the modal", () => {
  assert.match(source, /previewHtmlString\(file\.content, displayName, url\)/);
});

test("answer_artifacts is handled and can patch already-finalized cards", () => {
  assert.match(source, /onStreamEvent\("answer_artifacts"/);
  assert.match(source, /function _applyAnswerArtifactsToLastBubble\(/);
  assert.match(source, /_answerArtifacts = \[\];\s*\/\/ belongs to the turn/);
});

test("a persisted deliverable gets the same rich card as a tool-written file", () => {
  // build-1.md (written from the answer text) showed a thin one-line row while
  // Program.cs (written by write_file) got the full card, though both are just
  // a file in the workspace behind a URL. Same thing, same card.
  assert.match(source, /function _upgradeDeliverableCard\(/);
  assert.match(source, /_addRichDeliverableCard\(card\.parentNode, artifact, card\)/);
  assert.match(source, /rack\.appendChild\(_buildGeneratedFileCard\(artifact\)\)/);
  // No URL means nothing for the rich card to open, so the thin card stays.
  assert.match(source, /if \(!artifact\?\.url \|\| !card\.parentNode\) return false;/);
  // While the build is still running the thin card keeps its spinner.
  assert.match(source, /if \(!building && artifact\?\.url\) \{ _addRichDeliverableCard/);
  // Both entry points upgrade: the finalize sync and the late artifacts event.
  assert.match(source, /if \(_upgradeDeliverableCard\(existing\[i\], artifact\)\) return;/);
  assert.match(source, /if \(_upgradeDeliverableCard\(card, _answerArtifacts\[i\]\)\) return;/);
  // Cards share the same rack the generated-file path uses, so several
  // deliverables lay out as one shelf instead of a column.
  assert.match(source, /rack\.dataset\.cards = n >= 3 \? "3\+" : String\(n\)/);
});

test("a long answer keeps following the stream instead of stranding the reader", () => {
  // Autoscroll used to re-decide from distance on every frame, so a single
  // frame that grew the bubble past the threshold — a mermaid diagram
  // finishing, a table, a long list — read as "the user scrolled away" and
  // following stopped for the rest of the answer. Following is now a flag the
  // reader sets by scrolling; growing content fires no scroll event, so those
  // frames cannot clear it.
  assert.match(chatSource, /let _followBottom = true;/);
  assert.match(chatSource, /addEventListener\("scroll", \(\) => \{ _followBottom = isNearBottom\(\); \}/);
  assert.match(chatSource, /if \(force \|\| _followBottom\)/);
  assert.doesNotMatch(chatSource, /if \(force \|\| isNearBottom\(\)\)/);
});

test("streaming re-highlights only the bubble that changed", () => {
  // Prism.highlightAll() walks the whole document, so the per-frame cost grew
  // with the length of the entire conversation: measured 0.31 ms/frame at 5
  // code blocks and 1.88 ms/frame at 60, against a flat 0.03 ms/frame scoped.
  assert.match(markdownSource, /function highlightAll\(root\)/);
  assert.match(markdownSource, /Prism\.highlightAllUnder\(root\)/);
  assert.match(source, /highlightAll\(ref\.bubble\)/);
});

test("a diagram already drawn is emitted as its SVG, not re-derived per frame", () => {
  // The bubble's markup is rebuilt every frame. Emitting the raw source and
  // letting the scheduler swap the SVG in afterwards meant each frame briefly
  // held a differently-sized box where the diagram belongs.
  assert.match(markdownSource, /const drawn = _mermaidSvgCache\.get\(diagram\);/);
  assert.match(markdownSource, /drawn \? ' data-mermaid-rendered="cached"' : ''/);
  assert.match(markdownSource, /\(drawn \|\| escapeHtml\(diagram\)\)/);
});

test("generated XLSX cards open the spreadsheet preview modal", () => {
  assert.match(badgeSource, /const canPreviewSpreadsheet = ext === "xlsx"/);
  assert.match(badgeSource, /openGeneratedSpreadsheetModal\(url, name\)/);
  assert.match(indexSource, /scripts\/spreadsheet-preview\.js/);
  assert.match(spreadsheetSource, /fetch\(`\/api\/artifact\/preview\?url=/);
  assert.match(spreadsheetSource, /table\.className = "fpm-sheet-table"/);
});

test("generated file cards expose the Aperio hierarchy and responsive treatment", () => {
  assert.match(badgeSource, /generated-file-card aperio-file-card/);
  assert.match(badgeSource, /Ready to preview/);
  assert.match(badgeSource, /gfc-actions/);
  assert.match(badgeSource, /gfc-download-btn/);
  assert.match(attachmentCss, /\.gfc-status/);
  assert.match(attachmentCss, /\.gfc-actions/);
  assert.match(attachmentCss, /@media \(max-width: 620px\)/);
});

test("the generated-file plate is drawn, theme-derived, and kind-aware", () => {
  // A flat glyph made every artifact look identical; the plate illustration is
  // what tells a spreadsheet from a source file at a glance.
  assert.match(badgeSource, /function _fileArt\(/);
  for (const art of ["sheet", "image", "slides", "doc"]) {
    assert.match(badgeSource, new RegExp(`"${art}"`), `missing ${art} art variant`);
  }
  assert.match(badgeSource, /_fileArt\(art\)/);
  // Source files must name their language, not shout the extension.
  assert.match(badgeSource, /_LANG_LABEL\[ext\] \|\| label/);
  // The plate follows the theme accent rather than hardcoding indigo.
  assert.match(attachmentCss, /\.gfc-icon\s*\{[^}]*var\(--accent\)/s);
  assert.match(attachmentCss, /\.gfc-art \.sheet/);
});

test("the workspace chip states where the file landed, never a memory claim", () => {
  // A chip has to be backed by something the card actually knows.
  assert.match(badgeSource, /\/\\\/uploads\\\/\/\.test\(url \|\| ""\) \? "uploads" : "workspace"/);
  assert.match(attachmentCss, /\.gfc-chip/);
});

test("an inline code block is only collapsed once it is genuinely long", () => {
  // Collapsing at 12 lines hid the answer itself: a 26-line function arrived
  // behind an "expand" button, with copy/download chrome duplicating the card
  // sitting right below it.
  assert.match(source, /lineCount > 50 \|\| text\.length > 6000/);
  assert.doesNotMatch(source, /lineCount > 12/);
});

test("a code block duplicating a saved file is dropped, but only on proof", () => {
  assert.match(badgeSource, /function _dropInlineDuplicateOfFile\(/);
  assert.match(badgeSource, /_dropInlineDuplicateOfFile\(container, msg\)/);
  // Proof = the bytes actually saved, not a filename or language guess.
  assert.match(badgeSource, /await fetch\(url\)/);
  assert.match(badgeSource, /saved\.includes\(inline\) \|\| inline\.includes\(saved\)/);
  // A one-liner is a substring of anything, so short blocks are never removed.
  assert.match(badgeSource, /text\.split\("\\n"\)\.length >= 5 \|\| text\.length >= 200/);
  // A failed fetch must leave the block alone rather than delete unseen content.
  assert.match(badgeSource, /catch \{ return; \}\s*\/\/ offline/);
});

test("several generated files share one rack and lay out in rows", () => {
  // Five files in a turn used to render as a five-storey column of full-width
  // cards. They go into one rack that flows 2–3 per row instead.
  assert.match(badgeSource, /function _appendGeneratedFileCard\(/);
  assert.match(badgeSource, /rack\.className = "gfc-rack"/);
  assert.match(badgeSource, /rack\.dataset\.cards = n >= 3 \? "3\+" : String\(n\)/);
  // Every call site must go through the rack, or a card escapes the grid.
  assert.doesNotMatch(turnSource, /appendChild\(_buildGeneratedFileCard/);
  assert.doesNotMatch(knowledgeSource, /appendChild\(_buildGeneratedFileCard/);
  assert.match(turnSource, /_appendGeneratedFileCard\(/);
  assert.match(knowledgeSource, /_appendGeneratedFileCard\(/);
  // Rows are the CSS half of the same contract.
  assert.match(attachmentCss, /\.gfc-rack\[data-cards="2"\][^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(attachmentCss, /\.gfc-rack\[data-cards="3\+"\][^}]*repeat\(auto-fit, minmax\(220px, 1fr\)\)/s);
  // …and a racked card drops to its compact form so the buttons still fit.
  assert.match(attachmentCss, /\.gfc-rack:not\(\[data-cards="1"\]\) \.generated-file-card/);
});

test("spreadsheet preview scrolls vertically and horizontally for large tables", () => {
  assert.match(attachmentCss, /\.fpm-sheet-scroll\s*\{[^}]*overflow:\s*auto/s);
  assert.match(attachmentCss, /\.fpm-sheet-table\s*\{[^}]*min-width:\s*max-content/s);
  assert.match(attachmentCss, /\.fpm-sheet-table\s+th\s*,\s*\.fpm-sheet-table\s+td\s*\{[^}]*white-space:\s*nowrap/s);
});

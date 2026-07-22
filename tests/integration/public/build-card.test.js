import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The streaming modules are classic scripts built on shared browser globals, and
// the project has no DOM test library, so these are source-level invariants over
// the exact files loaded by public/index.html. Each one encodes a bug that
// actually shipped: a build card that froze mid-generation, and one that could
// never offer open-in-browser / show-in-folder.
const source = [
  "public/scripts/streaming/state.js",
  "public/scripts/streaming/handler.js",
  "public/scripts/streaming/deliverables.js",
].map(file => readFileSync(resolve(file), "utf8")).join("\n");
const indexSource = readFileSync(resolve("public/index.html"), "utf8");
const css = readFileSync(resolve("public/styles/messages/misc.css"), "utf8");
const indicatorCss = readFileSync(resolve("public/styles/tool-and-thinking-indicators.css"), "utf8");
const badgeSource = readFileSync(resolve("public/scripts/streaming/badges.js"), "utf8");
const renderingSource = readFileSync(resolve("public/scripts/rendering.js"), "utf8");
const spreadsheetSource = readFileSync(resolve("public/scripts/spreadsheet-preview.js"), "utf8");
const attachmentCss = readFileSync(resolve("public/styles/msg-attachments.css"), "utf8");

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
  assert.match(source, /msg\.type === "answer_artifacts"/);
  assert.match(source, /function _applyAnswerArtifactsToLastBubble\(/);
  assert.match(source, /_answerArtifacts = \[\];\s*\/\/ belongs to the turn/);
});

test("generated XLSX cards open the spreadsheet preview modal", () => {
  assert.match(badgeSource, /const canPreviewSpreadsheet = ext === "xlsx"/);
  assert.match(badgeSource, /openGeneratedSpreadsheetModal\(url, name\)/);
  assert.match(indexSource, /scripts\/spreadsheet-preview\.js/);
  assert.match(spreadsheetSource, /fetch\(`\/api\/artifact\/preview\?url=/);
  assert.match(spreadsheetSource, /table\.className = "fpm-sheet-table"/);
});

test("spreadsheet preview scrolls vertically and horizontally for large tables", () => {
  assert.match(attachmentCss, /\.fpm-sheet-scroll\s*\{[^}]*overflow:\s*auto/s);
  assert.match(attachmentCss, /\.fpm-sheet-table\s*\{[^}]*min-width:\s*max-content/s);
  assert.match(attachmentCss, /\.fpm-sheet-table\s+th\s*,\s*\.fpm-sheet-table\s+td\s*\{[^}]*white-space:\s*nowrap/s);
});

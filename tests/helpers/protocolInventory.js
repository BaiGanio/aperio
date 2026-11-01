// tests/helpers/protocolInventory.js
// The WS message protocol has no formal schema: server.js → lib/handlers/ →
// lib/agent/ agree on message shapes by hand (AGENTS.md's coupling map). The
// browser pins its half in tests/integration/public/streaming-router.test.js
// with a hand-written list, which only fails when the *browser* changes — a new
// server event slips past it silently. #539's P2 finding asks for the other
// direction: read the protocol surface out of the source and fail when an
// addition is not classified for the terminal.
//
// So these collectors scrape, rather than restate, three sets:
//
//   • outbound — every event type a chat producer can push at an emitter
//   • inbound  — every message type the WS handler's switch accepts
//   • cli      — every event type lib/emitters/cliEmitter.js has a case for
//
// Scraping is deliberately the point. A hand-maintained list cannot fail on an
// addition it was never told about; a scraper can.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Files and directories that can push an event at a chat emitter. Narrow on
 * purpose: `send(`/`.send(` is a common method name (HTTP responses, sockets,
 * child processes), so a repo-wide scan would collect noise and the test would
 * cry wolf. Everything here feeds either makeWsEmitter (browser + proxy) or
 * makeCliEmitter directly (standalone).
 */
export const EVENT_PRODUCERS = [
  "lib/emitters/handlers/wsHandler.js",
  "lib/emitters/handlers/ws",
  "lib/agent",
  "lib/workers/roundtable.js",
  "lib/server/roundtable.js",
  "lib/context",
];

/**
 * The one hole in the scrape, declared rather than papered over.
 *
 * Nearly every event is written at its `send(` call site, where the scraper can
 * read it. A few are built by a factory that returns the whole envelope, and the
 * caller then does `emitter.send(envelope)` — the type name is nowhere near a
 * `send(`, so no amount of windowing finds it. Those are listed here with the
 * module that mints them, and `protocol-parity.test.js` asserts each file still
 * contains that type, so a rename or a deletion fails instead of quietly
 * shrinking the protocol surface.
 *
 * Adding an event this way is the discouraged path. Prefer writing the type at
 * the call site.
 */
export const INDIRECT_EVENT_PRODUCERS = {
  // buildWorkflowSuggestion() returns the envelope; tool-hooks.js sends it whole.
  workflow_suggestion: "lib/agent/workflow-detection.js",
};

const CLI_EMITTER = "lib/emitters/cliEmitter.js";
const WS_HANDLER  = "lib/emitters/handlers/wsHandler.js";
// The proxy's outbound surface spans two files: the commands build most
// messages inline, while the confirmation/interrupt shapes live in confirm.js
// so they can be tested without a socket.
const PROXY_SOURCES = ["lib/terminal/proxy.js", "lib/terminal/confirm.js"];

function walk(absPath, out = []) {
  const st = statSync(absPath);
  if (st.isFile()) {
    if (absPath.endsWith(".js")) out.push(absPath);
    return out;
  }
  for (const entry of readdirSync(absPath)) walk(join(absPath, entry), out);
  return out;
}

/** Absolute paths of every producer file, resolved from EVENT_PRODUCERS. */
export function producerFiles() {
  const files = [];
  for (const rel of EVENT_PRODUCERS) walk(resolve(ROOT, rel), files);
  return files.sort();
}

// A type name as the protocol writes them: lower snake_case.
const TYPE_NAME = "[a-z][a-z0-9_]*";

/**
 * Pull the event type out of one `send(` call site.
 *
 * Two shapes are in use and both must be read, including across line breaks —
 * the object form is usually formatted over several lines:
 *
 *   send("session_branched", { ok: true })      → leading string literal
 *   emitter.send({ type: "stream_start" })      → `type:` in the first argument
 *
 * `window` is the source after the opening paren. The object form only matches
 * when `type:` is the object's first key, which is the house style everywhere
 * in lib/ — anything else returns null and shows up as an unclassified gap
 * rather than being silently skipped.
 *
 * @param {string} window
 * @returns {string|null}
 */
function typeFromCallSite(window) {
  const literal = window.match(new RegExp(`^\\s*"(${TYPE_NAME})"`));
  if (literal) return literal[1];
  const object = window.match(new RegExp(`^\\s*\\{\\s*type:\\s*"(${TYPE_NAME})"`));
  return object ? object[1] : null;
}

/**
 * Every event type a chat producer can emit, as `Map<type, string[] of
 * repo-relative files>`. The file list is what makes a failure actionable:
 * the test can name where the unclassified event came from.
 *
 * @returns {Map<string, string[]>}
 */
export function collectOutboundEvents() {
  const found = new Map();
  for (const abs of producerFiles()) {
    const rel = abs.slice(ROOT.length + 1);
    const src = readFileSync(abs, "utf-8");
    const callSite = /\bsend\(/g;
    let m;
    while ((m = callSite.exec(src)) !== null) {
      // 240 chars is comfortably past `type:` even with a comment line between
      // the paren and the first key.
      const type = typeFromCallSite(src.slice(m.index + m[0].length, m.index + m[0].length + 240));
      if (!type) continue;
      if (!found.has(type)) found.set(type, []);
      const files = found.get(type);
      if (!files.includes(rel)) files.push(rel);
    }
  }
  for (const [type, rel] of Object.entries(INDIRECT_EVENT_PRODUCERS)) {
    if (!found.has(type)) found.set(type, []);
    if (!found.get(type).includes(rel)) found.get(type).push(rel);
  }
  return found;
}

/**
 * Read a `switch` arm list out of a source file by scraping `case "x":`. Both
 * files this is used on (cliEmitter.js, wsHandler.js) hold exactly one such
 * switch, which the caller's own tests pin.
 *
 * @param {string} rel
 * @returns {string[]}
 */
function caseLabels(rel) {
  const src = readFileSync(resolve(ROOT, rel), "utf-8");
  const labels = [...src.matchAll(new RegExp(`case\\s+"(${TYPE_NAME})"\\s*:`, "g"))].map(m => m[1]);
  return [...new Set(labels)].sort();
}

/** Event types lib/emitters/cliEmitter.js has an explicit case for. */
export function collectCliHandledEvents() {
  return caseLabels(CLI_EMITTER);
}

/** Inbound message types the WS handler's switch accepts. */
export function collectInboundTypes() {
  return caseLabels(WS_HANDLER);
}

/**
 * Message types the terminal proxy sends to the server. Covers the inline
 * `safeSend({ type: "x" })` calls, the `chatPayload` object built up before the
 * final send, and the decision shapes returned by confirm.js.
 *
 * @returns {string[]}
 */
export function collectProxySentTypes() {
  const types = [];
  for (const rel of PROXY_SOURCES) {
    const src = readFileSync(resolve(ROOT, rel), "utf-8");
    for (const m of src.matchAll(new RegExp(`type:\\s*"(${TYPE_NAME})"`, "g"))) types.push(m[1]);
  }
  return [...new Set(types)].sort();
}

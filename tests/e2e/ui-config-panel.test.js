// tests/e2e/ui-config-panel.test.js
// Phase 8: UI tests for the Config Panel (issue #203).
// Tests the server-side HTML rendering and API responses that the SPA
// consumes. No browser required — verifies the server correctly generates
// the content that a real browser would render.
//
// System touches: child process (spawn), OS-assigned port (0),
// temp dir for .env file.
// No browser, no external network, no real DB, no AI provider.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE   = resolve(__dirname, "fixtures", "ui-server.js");

// ─── Helpers ──────────────────────────────────────────────────────────────

function fetchJSON(port, path) {
  return fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.json());
}

function fetchText(port, path) {
  return fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.text());
}

function readPort(server, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error("No PORT")), timeout);
    let buf = "";
    server.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/PORT:(\d+)/);
      if (m) { clearTimeout(tid); resolve(Number(m[1])); }
    });
    server.on("exit", (c) => { clearTimeout(tid); reject(new Error(`exited ${c}`)); });
  });
}

// ─── Suite ────────────────────────────────────────────────────────────────
describe("Config Panel (HTTP-level) — Phase 8", () => {
  let srv, port;

  before(async () => {
    srv = spawn(process.execPath, [FIXTURE], { stdio: ["ignore", "pipe", "inherit"] });
    port = await readPort(srv);
  });

  after(() => { if (srv) srv.kill(); });

  // ── 1. Page serves HTML ─────────────────────────────────────────────
  test("root URL returns HTML with config panel title", async () => {
    const html = await fetchText(port, "/");
    assert.ok(html.includes("Config Panel"), "HTML contains 'Config Panel'");
    assert.ok(html.includes("<h1>"), "HTML includes h1 tag");
    assert.ok(html.includes("</html>"), "HTML is well-formed (closing tag)");
  });

  // ── 2. HTML includes script that fetches schema ──────────────────────
  test("HTML includes inline script to fetch /api/config/schema", async () => {
    const html = await fetchText(port, "/");
    assert.ok(html.includes("/api/config/schema"), "script references schema endpoint");
    assert.ok(html.includes("fetch("), "script uses fetch API");
    assert.ok(html.includes("loadConfig()"), "script calls loadConfig");
  });

  // ── 3. Config schema endpoint ────────────────────────────────────────
  test("/api/config/schema returns fields and sections", async () => {
    const schema = await fetchJSON(port, "/api/config/schema");
    assert.ok(Array.isArray(schema.fields), "fields is array");
    assert.ok(schema.fields.length >= 5, `at least 5 fields, got ${schema.fields.length}`);
    assert.ok(Array.isArray(schema.sections), "sections is array");
    assert.ok(schema.sections.length >= 1, "at least 1 section");
  });

  // ── 4. Known config keys present ────────────────────────────────────
  test("schema includes AI_PROVIDER, LLAMACPP_MODEL, PORT", async () => {
    const schema = await fetchJSON(port, "/api/config/schema");
    const keys = schema.fields.map((f) => f.key);
    assert.ok(keys.includes("AI_PROVIDER"), "AI_PROVIDER present");
    assert.ok(keys.includes("LLAMACPP_MODEL"), "LLAMACPP_MODEL present");
    assert.ok(keys.includes("PORT"), "PORT present");
  });

  // ── 5. Fields have source labels ────────────────────────────────────
  test("fields include source labels (default when unset)", async () => {
    const schema = await fetchJSON(port, "/api/config/schema");
    for (const f of schema.fields) {
      assert.ok(f.source, `field ${f.key} has a source`);
    }
    // With no DB/env overrides, most Tier-1 fields should be "default"
    const llamacpp = schema.fields.find((f) => f.key === "LLAMACPP_MODEL");
    assert.equal(llamacpp.source, "default", "LLAMACPP_MODEL source is default");
  });

  // ── 6. Fields include type metadata ─────────────────────────────────
  test("fields include type, tier, editable, secret info", async () => {
    const schema = await fetchJSON(port, "/api/config/schema");
    const f = schema.fields.find((x) => x.key === "PORT");
    assert.ok(f, "PORT field found");
    assert.equal(f.type, "number", "PORT type is number");
    assert.equal(f.tier, 0, "PORT tier is 0");
    assert.equal(f.editable, false, "PORT is not editable");
  });

  // ── 7. Precedence in response ───────────────────────────────────────
  test("schema includes precedence field", async () => {
    const schema = await fetchJSON(port, "/api/config/schema");
    assert.ok(schema.precedence, "precedence present");
    // Default is "env" when APERIO_CONFIG_PRECEDENCE is unset
    assert.equal(schema.precedence, "env");
  });

  // ── 8. Warnings array ──────────────────────────────────────────────
  test("schema includes warnings array", async () => {
    const schema = await fetchJSON(port, "/api/config/schema");
    assert.ok(Array.isArray(schema.warnings), "warnings is array");
    // With no AI_PROVIDER=llamacpp and no mismatch, it should be empty
    assert.equal(schema.warnings.length, 0, "no warnings in default state");
  });
});

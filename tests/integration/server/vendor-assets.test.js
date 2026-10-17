// Tests for the self-hosted vendor asset routes in setupRoutes.js (#466).
//
// These run against a REAL Express app on an ephemeral port, not the mock used
// by setupRoutes.test.js, because the two things worth proving here only exist
// in real routing: that Express strips the `?hash` suffix the Bootstrap Icons
// stylesheet appends to its font URLs, and that the allowlist regex actually
// stops a traversal attempt after Express has normalized the path.
//
// Why the routes exist at all: SRI does not cascade. The CDN stylesheet was
// hash-pinned, but the .woff2 it then requests carried no integrity attribute,
// so a compromised CDN could still ship arbitrary font bytes. Serving both from
// the pinned npm package removes the CDN from that path entirely.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

let server;
let base;

before(async () => {
  const { registerSetupRoutes } = await import("../../../lib/server/setupRoutes.js");
  const app = express();
  registerSetupRoutes({
    app,
    root: ROOT,
    PORT: 0,
    isBootstrapped: () => true,
    getBootstrapMeta: () => ({}),
    getBootstrapStarted: () => false,
    setBootstrapStarted: () => {},
    getAppReady: () => true,
    bootAppOnce: () => {},
  });
  server = await new Promise((done) => {
    const s = app.listen(0, "127.0.0.1", () => done(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((done) => server.close(done));
});

// ═══════════════════════════════════════════════════════════════════════════
// Bootstrap Icons — stylesheet
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /vendor/bootstrap-icons/bootstrap-icons.min.css", () => {
  test("serves the stylesheet from the pinned npm package", async () => {
    const res = await fetch(`${base}/vendor/bootstrap-icons/bootstrap-icons.min.css`);
    assert.equal(res.status, 200);
    const css = await res.text();
    assert.match(css, /@font-face/);
    assert.match(css, /bootstrap-icons\.woff2/);
    assert.match(css, /\.bi-house/);
  });

  test("the served bytes are the package bytes, byte for byte", async () => {
    const res = await fetch(`${base}/vendor/bootstrap-icons/bootstrap-icons.min.css`);
    const served = Buffer.from(await res.arrayBuffer());
    const onDisk = await readFile(resolve(ROOT, "node_modules/bootstrap-icons/font/bootstrap-icons.min.css"));
    assert.ok(served.equals(onDisk));
  });

  test("the stylesheet points at the sibling /fonts/ route, not a CDN", async () => {
    const css = await (await fetch(`${base}/vendor/bootstrap-icons/bootstrap-icons.min.css`)).text();
    assert.doesNotMatch(css, /cdn\.jsdelivr\.net/);
    assert.match(css, /url\(["']?\.?\/?fonts\/bootstrap-icons\.woff2/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bootstrap Icons — font files
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /vendor/bootstrap-icons/fonts/:file", () => {
  test("serves the woff2", async () => {
    const res = await fetch(`${base}/vendor/bootstrap-icons/fonts/bootstrap-icons.woff2`);
    assert.equal(res.status, 200);
    const bytes = Buffer.from(await res.arrayBuffer());
    // woff2 magic number: the four ASCII bytes "wOF2".
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "wOF2");
  });

  test("serves the woff", async () => {
    const res = await fetch(`${base}/vendor/bootstrap-icons/fonts/bootstrap-icons.woff`);
    assert.equal(res.status, 200);
    const bytes = Buffer.from(await res.arrayBuffer());
    // woff magic number: "wOFF".
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "wOFF");
  });

  // The stylesheet requests `./fonts/bootstrap-icons.woff2?<cache-buster>`.
  // If the route did its own string matching on the raw URL instead of relying
  // on the parsed param, this is the request that would 404 — and a missing
  // font fails silently as blank icon boxes, the exact failure mode of #466.
  test("tolerates the cache-busting query string the stylesheet appends", async () => {
    const suffix = (await (await fetch(`${base}/vendor/bootstrap-icons/bootstrap-icons.min.css`)).text())
      .match(/bootstrap-icons\.woff2(\?[^)"']*)/)?.[1] ?? "?dd67d0d5";
    const res = await fetch(`${base}/vendor/bootstrap-icons/fonts/bootstrap-icons.woff2${suffix}`);
    assert.equal(res.status, 200);
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString("latin1"), "wOF2");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Path guard — the allowlist regex IS the guard, so prove it holds
// ═══════════════════════════════════════════════════════════════════════════

describe("vendor font route path guard", () => {
  const escapes = [
    ["encoded parent segments", "/vendor/bootstrap-icons/fonts/..%2f..%2f..%2fpackage.json"],
    ["double-encoded parent segments", "/vendor/bootstrap-icons/fonts/..%252f..%252fpackage.json"],
    ["encoded absolute path", "/vendor/bootstrap-icons/fonts/%2Fetc%2Fpasswd"],
    ["absolute path", "/vendor/bootstrap-icons/fonts//etc/passwd"],
    ["a sibling package file", "/vendor/bootstrap-icons/fonts/../bootstrap-icons.css"],
    ["an arbitrary extension", "/vendor/bootstrap-icons/fonts/evil.js"],
    ["a dotfile", "/vendor/bootstrap-icons/fonts/.env"],
    ["a traversal suffix on an allowed name", "/vendor/bootstrap-icons/fonts/bootstrap-icons.woff2%2f..%2f..%2fpackage.json"],
  ];

  for (const [label, path] of escapes) {
    test(`refuses ${label}`, async () => {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 404, `${path} must not resolve`);
      const body = await res.text();
      assert.doesNotMatch(body, /"name":\s*"aperio"/, "leaked package.json");
      assert.doesNotMatch(body, /root:x:0:0/, "leaked /etc/passwd");
    });
  }

  test("refuses a traversal on the stylesheet route too", async () => {
    const res = await fetch(`${base}/vendor/bootstrap-icons/..%2f..%2fpackage.json`);
    assert.equal(res.status, 404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The pages must actually use the local route
// ═══════════════════════════════════════════════════════════════════════════

describe("public pages no longer load Bootstrap Icons from a CDN", () => {
  const pages = ["index.html", "setup.html", "codegraph-atlas.html"];

  for (const page of pages) {
    test(`${page} links the local stylesheet`, async () => {
      const html = await readFile(resolve(ROOT, "public", page), "utf8");
      assert.match(html, /href="\/vendor\/bootstrap-icons\/bootstrap-icons\.min\.css"/);
      assert.doesNotMatch(html, /cdn\.jsdelivr\.net\/npm\/bootstrap-icons/);
    });

    test(`${page} carries no dead integrity attribute on the local link`, async () => {
      const html = await readFile(resolve(ROOT, "public", page), "utf8");
      const tag = html.match(/<link[^>]*\/vendor\/bootstrap-icons\/bootstrap-icons\.min\.css[^>]*>/s)?.[0] ?? "";
      assert.ok(tag, "local stylesheet link not found");
      assert.doesNotMatch(tag, /\bintegrity\b/, "SRI on a same-origin file is meaningless");
      assert.doesNotMatch(tag, /\bcrossorigin\b/);
    });
  }

  // index.html still pins Mermaid on the CDN; that pin must survive this change
  // so check:sri keeps having something to verify.
  test("index.html keeps its Mermaid CDN pin", async () => {
    const html = await readFile(resolve(ROOT, "public", "index.html"), "utf8");
    assert.match(html, /cdn\.jsdelivr\.net\/npm\/mermaid@[\d.]+/);
    assert.match(html, /integrity="sha384-/);
  });
});

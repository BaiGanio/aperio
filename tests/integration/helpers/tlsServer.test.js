// tests/lib/helpers/tlsServer.test.js
// NET-01 — opt-in TLS via user-provided cert/key paths.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Server as HttpServer } from "http";
import { Server as HttpsServer } from "https";
import { createAppServer } from "../../../lib/helpers/tlsServer.js";

const app = (_req, _res) => {};
let dir, certPath, keyPath, haveCert = false;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aperio-tls-"));
  certPath = join(dir, "cert.pem");
  keyPath  = join(dir, "key.pem");
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1",
      "-subj", "/CN=localhost",
    ], { stdio: "ignore" });
    haveCert = true;
  } catch { /* openssl unavailable — TLS-success case is skipped */ }
});

after(() => { rmSync(dir, { recursive: true, force: true }); });

describe("createAppServer", () => {
  test("no cert/key env → plain HTTP", () => {
    const { server, secure } = createAppServer(app, {});
    assert.equal(secure, false);
    assert.ok(server instanceof HttpServer);
    server.close?.();
  });

  test("both cert+key → HTTPS", (t) => {
    if (!haveCert) return t.skip("openssl not available");
    const { server, secure } = createAppServer(app, {
      APERIO_TLS_CERT: certPath, APERIO_TLS_KEY: keyPath,
    });
    assert.equal(secure, true);
    assert.ok(server instanceof HttpsServer);
    server.close?.();
  });

  test("only one of cert/key set → throws", () => {
    assert.throws(() => createAppServer(app, { APERIO_TLS_CERT: certPath }), /BOTH/);
    assert.throws(() => createAppServer(app, { APERIO_TLS_KEY: keyPath }), /BOTH/);
  });
});

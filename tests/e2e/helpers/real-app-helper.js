// tests/e2e/helpers/real-app-helper.js
//
// Test helpers for the real-app E2E harness.
//
// Usage:
//   import { startRealApp, request } from "../helpers/real-app-helper.js";
//
//   test("my test", async (t) => {
//     const app = await startRealApp(t);
//     const res = await request(app, "/api/version");
//     assert.equal(res.status, 200);
//     await app.stop();
//   });

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "..", "fixtures", "real-app-server.js");

const READY_TIMEOUT = 15_000;

/**
 * Start the real-app server fixture as a child process.
 *
 * @param {object}        t         Node test context (for t.after cleanup)
 * @param {object=}       options
 * @param {number=}       options.readyTimeout  Milliseconds to wait for READY
 * @param {object=}       options.env           Extra env vars for the child
 * @returns {Promise<{port: number, pid: number, stop: () => Promise<void>,
 *   stdout: string[], stderr: string[]}>}
 */
export async function startRealApp(t, options = {}) {
  const { readyTimeout = READY_TIMEOUT, env = {} } = options;

  // Child process env — build from current env + overrides
  // PORT=0 by default so ensurePort() never races on a shared port.
  // Individual tests can override via the env option.
  const childEnv = {
    ...process.env,
    PORT: "0",
    NODE_ENV: "test",
    APERIO_BENCHMARK_RUN: "1",
    ...env,
  };

  const child = spawn(process.execPath, [FIXTURE], {
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });

  const stdoutLines = [];
  const stderrLines = [];
  let bootingData = null;
  let readyData = null;

  child.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      stdoutLines.push(line);
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "booting") bootingData = parsed;
        if (parsed.type === "ready") readyData = parsed;
      } catch {
        // Non-JSON output (e.g., logger lines) — ignore
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrLines.push(chunk.toString());
  });

  // Wait for the READY line
  const port = await new Promise((resolve, reject) => {
    const tid = setTimeout(() => {
      const lastLines = stdoutLines.slice(-10).join("\n");
      reject(new Error(
        `Real-app fixture did not produce READY within ${readyTimeout}ms.\n` +
        `Last stdout lines:\n${lastLines}\n` +
        `Stderr:\n${stderrLines.slice(-5).join("\n")}`
      ));
    }, readyTimeout);

    const check = (chunk) => {
      try {
        const lines = chunk.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          if (parsed.type === "ready" && parsed.port) {
            clearTimeout(tid);
            resolve(parsed.port);
            return;
          }
        }
      } catch { /* partial line — wait for more */ }
    };

    child.stdout.on("data", check);
    child.on("exit", (code) => {
      clearTimeout(tid);
      reject(new Error(`Fixture exited early (code ${code}) before READY`));
    });
  });

  // Register cleanup (SIGTERM, not SIGKILL — give it a chance to clean up)
  const stop = () => new Promise((resolve) => {
    if (child.killed) return resolve();
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.on("exit", () => { clearTimeout(timeout); resolve(); });
    child.kill("SIGTERM");
  });

  // Register test-level cleanup when a test context is provided.
  // When t is null (suite-level manual lifecycle), the caller manages cleanup.
  if (t && typeof t.after === "function") {
    t.after(async () => {
      try { await stop(); } catch { /* best-effort cleanup */ }
    });
  }

  return {
    port,
    pid: readyData?.pid ?? child.pid,
    stop,
    stdout: stdoutLines,
    stderr: stderrLines,
    bootingData,
    readyData,
  };
}

/**
 * Make an HTTP request to the running fixture.
 *
 * @param {object}  app        Returned from startRealApp()
 * @param {string}  path       URL path (e.g., "/api/version")
 * @param {object=} options
 * @param {string=} options.method      HTTP method (default: "GET")
 * @param {object=} options.headers     Request headers
 * @param {string=} options.body        Request body (string)
 * @returns {Promise<{status: number, headers: object, body: string, json: object|undefined}>}
 */
export function request(app, path, options = {}) {
  const { method = "GET", headers = {}, body } = options;
  const { port } = app;

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const bodyStr = Buffer.concat(chunks).toString("utf8");
          let json;
          try { json = JSON.parse(bodyStr); } catch { /* not JSON */ }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: bodyStr,
            json,
          });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

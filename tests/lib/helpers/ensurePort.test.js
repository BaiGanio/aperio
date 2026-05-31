// tests/lib/helpers/ensurePort.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { ensurePort } from "../../../lib/helpers/ensurePort.js";

// Helper: bind port 0 and return the assigned port, leaving the server open
async function occupyPort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.listen(0, "127.0.0.1", resolve);
    srv.once("error", reject);
  });
  return { srv, port: srv.address().port };
}

// Helper: bind a port briefly then release it, returning the (now free) port
async function findFreePort() {
  const { srv, port } = await occupyPort();
  await new Promise(r => srv.close(r));
  return port;
}

// =============================================================================
describe("ensurePort — port is already free", () => {

  test("resolves without error when port is free", async () => {
    const port = await findFreePort();
    await ensurePort(port); // must not throw
  });

  test("accepts port as string", async () => {
    const port = await findFreePort();
    await ensurePort(String(port));
  });

  test("resolves for multiple sequential calls on a free port", async () => {
    const port = await findFreePort();
    await ensurePort(port);
    // port is now free again (ensurePort released the probe)
    await ensurePort(port);
  });
});

// =============================================================================
describe("ensurePort — port in use, then freed", () => {

  test("resolves after the occupying process is killed", async (t) => {
    const { srv, port } = await occupyPort();

    // Mock process.kill so the "kill" action closes our test server instead
    t.mock.method(process, "kill", () => {
      srv.close();
    });

    // Fallback: close server after 100 ms if lsof didn't find a PID to kill
    const fallback = setTimeout(() => srv.close(), 100);

    await ensurePort(port);

    clearTimeout(fallback);
    // If we reach here without throwing, the port was freed and ensurePort returned.
  });

  test("resolves when port frees on its own during polling", async (t) => {
    const { srv, port } = await occupyPort();

    // Prevent lsof from triggering a real kill on our test process
    t.mock.method(process, "kill", () => {});

    // Close the server after a short delay — the poll loop will find it free
    setTimeout(() => srv.close(), 50);

    await ensurePort(port);
  });
});

// =============================================================================
describe("ensurePort — port stays occupied (timeout)", () => {

  test("throws descriptive error when port is not freed within MAX_WAIT_MS", async (t) => {
    // Block process.kill to prevent the test process from being killed
    t.mock.method(process, "kill", () => {});

    // Enable fake Date + setTimeout to skip the 8-second real wait
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });

    const { srv, port } = await occupyPort();

    const p = ensurePort(port).catch(e => e);

    // Wait for the synchronous setup inside ensurePort to finish:
    // initial isPortFree (real async I/O) + pidsOnPort (sync execSync) + deadline assignment
    for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r));

    // Advance fake time past MAX_WAIT_MS (8 000 ms) AND fire the poll setTimeout
    t.mock.timers.tick(9_000);

    // Allow isPortFree inside the poll loop to complete (real async I/O)
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));

    const err = await p;
    assert.ok(err instanceof Error, `Expected Error, got: ${err}`);
    assert.match(err.message, /still occupied/);
    assert.match(err.message, /8 s/);

    await new Promise(r => srv.close(r)).catch(() => {});
  });
});

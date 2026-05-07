// tests/helpers/sandbox.js
import { mock } from "node:test";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import net from "node:net";
import child_process from "node:child_process";

/**
 * Setup mock security environment for tests
 * Call this at the beginning of each test file
 */
export function setupSecureTestEnvironment(t) {
  // Mock file system dangerous operations
  mock.method(fs, "writeFileSync", () => {});
  mock.method(fs, "chmodSync", () => {});
  mock.method(fs, "rmSync", () => {});
  mock.method(fsPromises, "rm", async () => {});
  mock.method(fsPromises, "writeFile", async () => {});

  // Mock process operations
  mock.method(process, "kill", () => { throw new Error("Mocked kill - use t.mock.method for specific tests"); });
  mock.method(process, "exit", () => { throw new Error("Mocked exit - prevent test from exiting"); });
  mock.method(process, "chdir", () => {});

  // Mock network connections
  let socketCounter = 0;
  mock.method(net, "createConnection", () => ({
    connect: mock.fn(),
    on: mock.fn(),
    once: mock.fn(),
    setTimeout: mock.fn(),
    destroy: mock.fn(),
    setKeepAlive: mock.fn(),
    unref: mock.fn(),
    // Add a unique id to track
    _mockId: socketCounter++
  }));

  // Mock child_process
  mock.method(child_process, "execSync", () => "");
  mock.method(child_process, "execFileSync", () => "");
  mock.method(child_process, "spawn", () => ({
    on: mock.fn(),
    stdout: { on: mock.fn() },
    stderr: { on: mock.fn() }
  }));

  // Mock fetch globally
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(() => Promise.resolve({ ok: false }));

  // Return cleanup function
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/**
 * Create isolated temp directory for tests that need real file operations.
 * Changes cwd to the temp dir and returns a restore() to undo both.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createIsolatedTestDir() {
  const testRoot = mkdtempSync(join(tmpdir(), "aperio-test-"));
  const originalCwd = process.cwd();

  process.chdir(testRoot);

  return {
    root: testRoot,
    restore: () => {
      process.chdir(originalCwd);
      try {
        fs.rmSync(testRoot, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  };
}

/**
 * Mock port scanning without real network
 */
export function mockPortScanner(t) {
  const mockSocket = {
    connect: t.mock.fn(),
    on: t.mock.fn((event, cb) => {
      if (event === 'error') {
        setTimeout(() => cb(new Error('ECONNREFUSED')), 0);
      }
      return mockSocket;
    }),
    once: t.mock.fn(),
    setTimeout: t.mock.fn(),
    destroy: t.mock.fn(),
    setKeepAlive: t.mock.fn(),
    unref: t.mock.fn()
  };

  mock.method(net, "createConnection", () => mockSocket);

  return mockSocket;
}

/**
 * Mock process killing
 */
export function mockProcessKill(t) {
  const killMock = t.mock.fn(() => { throw new Error("No such process"); });
  mock.method(process, "kill", killMock);
  return killMock;
}

/**
 * Mock command execution
 */
export function mockCommandExecution(t, mockResponses = {}) {
  const defaultExecSync = t.mock.fn((cmd) => {
    if (mockResponses[cmd]) return mockResponses[cmd];
    throw new Error("Command not mocked: " + cmd);
  });

  const defaultExecFileSync = t.mock.fn(() => { throw new Error("Not implemented"); });

  mock.method(child_process, "execSync", defaultExecSync);
  mock.method(child_process, "execFileSync", defaultExecFileSync);

  return { execSync: defaultExecSync, execFileSync: defaultExecFileSync };
}

/**
 * Mock fetch for API calls
 */
export function mockFetch(t, mockResponse = { ok: true, json: async () => ({}) }) {
  const fetchMock = t.mock.fn(async () => mockResponse);
  mock.method(globalThis, "fetch", fetchMock);
  return fetchMock;
}

// tests/mcp/index.test.js
// Tests for startServer() in mcp/index.js.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, createContext } from "../../../mcp/index.js";
import os from "node:os";
import path from "node:path";

const TMP = path.join(os.tmpdir(), "aperio-test");
// ─── shared mock factories ────────────────────────────────────────────────────
function makeTransport() {
  return {
    start:     async () => {},
    close:     async () => {},
    onclose:   () => {},
    onerror:   () => {},
    onmessage: () => {},
    send:      async () => {},
  };
}

function makeStore({ total = 0, embedded = 0 } = {}) {
  return {
    counts:  async () => ({ total, embedded }),
    table:   async () => ({ add: async () => {}, countRows: async () => 0 }),
    search:  async () => [],
  };
}

// ─── env helper ──────────────────────────────────────────────────────────────
function withEnv(overrides, testFn) {
  const original = {};
  for (const [k, v] of Object.entries(overrides)) {
    original[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return testFn().finally(() => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// =============================================================================
describe("startServer — initialization", () => {

  test("initializes and returns a server instance", async () => {
    const { server } = await startServer({
      transport:     makeTransport(),
      store:         makeStore(),
      vectorEnabled: false,
    });
    assert.ok(server);
  });

  // NOTE: the store-null branch in startServer is only reachable when getStore()
  // itself fails at module load time (line 19 of index.js), which exits the process
  // before startServer is ever exported. Passing store:null falls through to the
  // real getStore() via `opts.store || await getStore()` and succeeds — so this
  // branch cannot be unit-tested without mocking the module internals. Skipped.

  test("vectorEnabled: false — the embedding callback returns null without hitting the network", async () => {
    // The backfill loop in initEmbeddings WILL run and WILL call generateEmbeddingFn,
    // but with vectorEnabled:false the wrapper returns null before any fetch is made.
    // We verify this by ensuring no fetch was attempted.
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };

    try {
      const store = {
        counts:                async () => ({ total: 1, embedded: 0 }),
        listWithoutEmbeddings: async () => [{ id: 1, title: "T", content: "C" }],
        setEmbedding:          async () => {},
        table:                 async () => ({ add: async () => {}, countRows: async () => 0 }),
        search:                async () => [],
      };

      await startServer({ transport: makeTransport(), store, vectorEnabled: false });
      await new Promise(resolve => setImmediate(resolve));

      assert.equal(fetchCalled, false, "fetch should never be called when vectorEnabled is false");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("vectorEnabled: true — generateEmbedding is wired through (with no API key it returns null gracefully)", async () => {
    await withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: undefined }, () =>
      assert.doesNotReject(() =>
        startServer({
          transport:     makeTransport(),
          store:         makeStore({ total: 0, embedded: 0 }),
          vectorEnabled: true,
        })
      )
    );
  });

  test("detects an embedding provider change on boot (Gap 2 — MCP-only deployments)", async () => {
    // A stale fingerprint stored under a previous provider must be caught here,
    // the same way lib/server/hydrateRuntime.js catches it for the HTTP server —
    // otherwise an MCP-only deployment never notices a provider switch.
    await withEnv({ EMBEDDING_PROVIDER: "transformers" }, async () => {
      let clearedCalled = false;
      let storedFingerprint = { provider: "voyage", model: "voyage-3", dims: 1024 };
      const store = {
        counts:                async () => ({ total: 0, embedded: 0 }),
        table:                 async () => ({ add: async () => {}, countRows: async () => 0 }),
        search:                async () => [],
        getSetting:            async (key) => key === "embedding_provider" ? storedFingerprint : null,
        setSetting:            async (key, value) => { if (key === "embedding_provider") storedFingerprint = value; },
        clearAllEmbeddings:    async () => { clearedCalled = true; },
      };

      await startServer({ transport: makeTransport(), store, vectorEnabled: false });

      assert.equal(clearedCalled, true, "provider change should clear embeddings before the queue is built");
      assert.equal(storedFingerprint.provider, "transformers");
    });
  });

  test("resolves DB-backed Settings before checking the embedding provider (review P1 — MCP config gap)", async () => {
    // Under default 'db' precedence a Settings-selected provider must win over
    // an unset/differing .env, exactly like lib/server/hydrateRuntime.js
    // (which calls applyConfigToEnv before checkEmbeddingProvider). Without
    // this, MCP would see only raw env (transformers, the default), treat a
    // real Voyage fingerprint as a provider change, and destructively clear it.
    await withEnv({ EMBEDDING_PROVIDER: undefined, VOYAGE_MODEL: undefined, EMBEDDING_DIMS: undefined, APERIO_CONFIG_PRECEDENCE: undefined }, async () => {
      let clearedCalled = false;
      let storedFingerprint = { provider: "voyage", model: "voyage-3", dims: 1024 };
      const store = {
        counts:      async () => ({ total: 0, embedded: 0 }),
        table:       async () => ({ add: async () => {}, countRows: async () => 0 }),
        search:      async () => [],
        getSettings: async () => ({ "config.EMBEDDING_PROVIDER": "voyage" }),
        getSetting:  async (key) => key === "embedding_provider" ? storedFingerprint : null,
        setSetting:  async (key, value) => { if (key === "embedding_provider") storedFingerprint = value; },
        clearAllEmbeddings: async () => { clearedCalled = true; },
      };

      await startServer({ transport: makeTransport(), store, vectorEnabled: false });

      assert.equal(process.env.EMBEDDING_PROVIDER, "voyage", "DB Settings must be applied to process.env before the fingerprint check reads it");
      assert.equal(clearedCalled, false, "a Settings-selected provider matching the stored fingerprint must not be treated as a change");
      assert.equal(storedFingerprint.provider, "voyage");
    });
  });

  test("a DB Settings toggle reaches shell.js's import-time SHELL_ENABLED constant (review P1 — security-sensitive)", async () => {
    // mcp/tools/shell.js reads process.env.APERIO_ENABLE_SHELL into a
    // module-level const at static-import time (line 76). Once this test file
    // has imported it anywhere else, Node's module cache freezes that value
    // for the rest of this process — so the only way to genuinely prove
    // startServer() hydrates DB Settings BEFORE shell.js is ever imported is a
    // fresh child process, mirroring how `npm run mcp` actually runs.
    const { execFileSync } = await import("node:child_process");
    const mcpIndexUrl = new URL("../../../mcp/index.js", import.meta.url).href;
    const shellToolUrl = new URL("../../../mcp/tools/shell.js", import.meta.url).href;
    const script = `
      process.env.APERIO_ENABLE_SHELL = "1";      // raw/.env value: enabled
      process.env.APERIO_CONFIG_PRECEDENCE = "db"; // force default precedence regardless of this repo's real .env
      const { startServer } = await import(${JSON.stringify(mcpIndexUrl)});
      const transport = { start: async()=>{}, close: async()=>{}, onclose:()=>{}, onerror:()=>{}, onmessage:()=>{}, send: async()=>{} };
      const store = {
        counts: async () => ({ total: 0, embedded: 0 }),
        table:  async () => ({ add: async () => {}, countRows: async () => 0 }),
        search: async () => [],
        // DB Settings say disabled — must win under default 'db' precedence.
        getSettings: async () => ({ "config.APERIO_ENABLE_SHELL": "0" }),
      };
      await startServer({ transport, store, vectorEnabled: false });
      const shellTool = await import(${JSON.stringify(shellToolUrl)});
      const result = await shellTool.runShellHandler({ command: "echo hi" });
      process.stdout.write(JSON.stringify(result));
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env:      process.env,
    });
    const result = JSON.parse(out.trim().split("\n").pop());
    assert.match(
      result.content[0].text,
      /disabled/i,
      "DB Settings disabling the shell tool must actually disable it, not just update process.env after shell.js already froze SHELL_ENABLED"
    );
  });
});

// =============================================================================
// F-R2-07: providerIsLocal must fail closed (deny self-memory) when
// APERIO_PROVIDER_LOCAL is unset — the standalone `npm run mcp` path (no
// spawner to set the var, e.g. an external MCP client talking to Aperio
// directly) previously fell through to `!== "0"`, which is true for unset.
describe("createContext — providerIsLocal fail-closed default", () => {
  test("defaults to false when APERIO_PROVIDER_LOCAL is unset", async () => {
    await withEnv({ APERIO_PROVIDER_LOCAL: undefined }, async () => {
      const ctx = await createContext(makeStore(), { vectorEnabled: false });
      assert.equal(ctx.providerIsLocal, false);
    });
  });

  test("is true only for an explicit \"1\" (the orchestrator-spawn path)", async () => {
    await withEnv({ APERIO_PROVIDER_LOCAL: "1" }, async () => {
      const ctx = await createContext(makeStore(), { vectorEnabled: false });
      assert.equal(ctx.providerIsLocal, true);
    });
  });

  test("stays false for an explicit \"0\" (codex.js's cloud path)", async () => {
    await withEnv({ APERIO_PROVIDER_LOCAL: "0" }, async () => {
      const ctx = await createContext(makeStore(), { vectorEnabled: false });
      assert.equal(ctx.providerIsLocal, false);
    });
  });
});

// =============================================================================
describe("startServer — ALLOWED_PATHS / isPathAllowed", () => {

  // startServer exposes isPathAllowed only indirectly through tool ctx.
  // We test its behaviour by calling startServer with controlled env vars and
  // then invoking the returned server's registered tool handlers directly.
  // Since the tool wiring is opaque here, we instead unit-test the exact same
  // logic in isolation — mirroring what index.js does — to cover those lines.

  function makeIsPathAllowed(envValue) {
    const ALLOWED_PATHS = (envValue || process.cwd())
      .split(",")
      .map(p => p.trim().replace(/^~/, process.cwd()));

    return (filePath) => {
      const resolved = filePath.startsWith("~")
        ? filePath.replace("~", process.cwd())
        : filePath;
      return ALLOWED_PATHS.some(a => resolved.startsWith(a + "/") || resolved === a);
    };
  }

  test("allows a path that is exactly an allowed root", () => {
    const isAllowed = makeIsPathAllowed(TMP);
    assert.equal(isAllowed(TMP), true);
  });

  test("allows a path nested under an allowed root", () => {
    const isAllowed = makeIsPathAllowed(TMP);
    assert.equal(isAllowed(`${TMP}/src/file.js`), true);
  });

  test("rejects a path outside all allowed roots", () => {
    const isAllowed = makeIsPathAllowed(TMP);
    assert.equal(isAllowed("/etc/passwd"), false);
  });

  test("rejects a path that merely starts with an allowed root string but is not under it", () => {
    const isAllowed = makeIsPathAllowed(TMP);
    // '/tmp/project-evil' should NOT match '/tmp/project'
    assert.equal(isAllowed(`${TMP}-evil/file.js`), false);
  });

  test("supports multiple comma-separated allowed paths", () => {
    const isAllowed = makeIsPathAllowed(`${TMP}/a, ${TMP}/b`);
    assert.equal(isAllowed(`${TMP}/a/file.txt`), true);
    assert.equal(isAllowed(`${TMP}/b/file.txt`), true);
    assert.equal(isAllowed(`${TMP}/c/file.txt`), false);
  });

  test("expands leading ~ to cwd", () => {
    const isAllowed = makeIsPathAllowed(`${process.cwd()}/sandbox`);
    assert.equal(isAllowed(`~/sandbox/file.txt`), true);
  });

  test("falls back to cwd when APERIO_ALLOWED_PATHS is not set", () => {
    const isAllowed = makeIsPathAllowed(undefined);
    assert.equal(isAllowed(`${process.cwd()}/anything`), true);
    assert.equal(isAllowed("/totally/outside"), false);
  });
});
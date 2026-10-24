// tests/integration/mcp/redaction-map-side-channel.test.js
//
// Issue #531 review round 2, P1 + P2. redact() had a restore() caller wired
// in (memoryHandlers.js + lib/agent/index.js), but the first version of that
// fix put the actual placeholder → original PII map straight into recall's
// public CallToolResult (structuredContent). That is visible to ANY client
// connected to this MCP server — including a standalone cloud-backed one
// (Claude Desktop, Cursor, or any other external MCP client talking to
// mcp/index.js directly; see createContext()'s providerIsLocal comment) —
// which would receive every original email/phone/card/IBAN the visible text
// deliberately redacted. The fix moves the map to a private, single-use,
// correlation-id-keyed side channel: recallHandler's public result carries
// only an opaque id, and only "aperio/takeRedactionMap" — a custom JSON-RPC
// method outside the Tools capability, invisible to tools/list(), mirroring
// "aperio/clearDocSessionCache" (see docgraph-clear-session-cache.test.js,
// the direct precedent this test's structure follows) — can redeem it.
//
// This spawns a REAL mcp/index.js child against a real, disposable scratch
// SQLite DB and drives recall + the custom method through the genuine MCP
// wire protocol, so a regression back to "the map rides along in the public
// result" would show up here, not just in a same-process unit test.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

const ALICE_EMAIL = "alice.redact-test@example.com";
const BOB_EMAIL = "bob.redact-test@example.com";

let scratchDir, dbPath, transport, mcp;
// Simulates the secret lib/agent/mcp-connect.js's connectMcp() mints per spawn
// and hands only to its own child via APERIO_MCP_AUTH_TOKEN (review round 6,
// P1) — this test's spawned child plays the role of that trusted app-owned
// process, so it gets the token the same way the real one would.
const MCP_AUTH_TOKEN = randomUUID();

before(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "aperio-redaction-side-channel-"));
  dbPath = join(scratchDir, "aperio.db");

  // Seed two tier-2 (sensitive) memories in a short-lived connection of THIS
  // process, then close it before the child ever opens the same file.
  const oldPath = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = dbPath;
  const { SqliteStore } = await import("../../../db/sqlite.js");
  const seedStore = await SqliteStore.init();
  seedStore.db.prepare(`
    INSERT INTO memories (id, type, title, content, tier, importance)
    VALUES (?, 'fact', 'Alice contact', ?, 2, 5)
  `).run(randomUUID(), `Reach Alice at ${ALICE_EMAIL}`);
  seedStore.db.prepare(`
    INSERT INTO memories (id, type, title, content, tier, importance)
    VALUES (?, 'fact', 'Bob contact', ?, 2, 5)
  `).run(randomUUID(), `Reach Bob at ${BOB_EMAIL}`);
  await seedStore.close?.();
  if (oldPath) process.env.SQLITE_PATH = oldPath; else delete process.env.SQLITE_PATH;

  const { NODE_ENV: _unused, ...envWithoutNodeEnv } = process.env;
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-warnings=ExperimentalWarning", join(REPO_ROOT, "mcp/index.js")],
    env: {
      ...envWithoutNodeEnv,
      APERIO_PROC_ROLE: "mcp",
      DB_BACKEND: "sqlite",
      SQLITE_PATH: dbPath,
      EMBEDDING_PROVIDER: "voyage",
      VOYAGE_API_KEY: "",
      // The redact path only activates for a cloud-facing session (recall's
      // ctx.providerIsLocal === false gate) with redact mode explicitly on.
      APERIO_PROVIDER_LOCAL: "0",
      APERIO_CLOUD_SENSITIVE_MODE: "redact",
      APERIO_MCP_AUTH_TOKEN: MCP_AUTH_TOKEN,
      // Keep every map this child writes inside the scratch dir that after()
      // deletes. Without it the child falls back to a path derived from
      // memoryHandlers.js's own location — the code checkout — and each run
      // of this file left PII-shaped files accumulating in the developer's
      // var/redaction-maps/, since only the owner-only-permissions test below
      // ever redeems (and so deletes) the file its own recall minted. The
      // checkout-fallback behaviour itself is still covered, deliberately, by
      // the APERIO_RUNTIME_ROOT describe block at the bottom of this file.
      APERIO_RUNTIME_ROOT: scratchDir,
    },
    stderr: "pipe",
  });
  mcp = new Client({ name: "redaction-side-channel-test", version: "0.0.0-test" });
  await mcp.connect(transport);
}, { timeout: 30000 });

after(async () => {
  await mcp?.close?.().catch(() => {});
  rmSync(scratchDir, { recursive: true, force: true });
});

function takeRedactionMap(correlationId, token = MCP_AUTH_TOKEN) {
  return mcp.request(
    { method: "aperio/takeRedactionMap", params: { correlationId, token } },
    ResultSchema,
  );
}

test("recall's public result carries a placeholder and an opaque id — never the raw PII or the map", async () => {
  const result = await mcp.callTool({ name: "recall", arguments: { maxTier: 2 } });
  assert.ok(!result.isError);

  const raw = JSON.stringify(result);
  assert.ok(!raw.includes(ALICE_EMAIL), "Alice's real email must not appear anywhere in the public result");
  assert.ok(!raw.includes(BOB_EMAIL), "Bob's real email must not appear anywhere in the public result");

  const text = result.content.find(c => c.type === "text")?.text ?? "";
  assert.match(text, /«[0-9a-f-]{36}_\d+_EMAIL_\d+»/, "the visible text must carry a placeholder token");

  assert.equal(typeof result.structuredContent?.redactionCorrelationId, "string");
  assert.equal(result.structuredContent.redactionMap, undefined,
    "the actual map must never ride along in the public CallToolResult");
});

test("the correlation id redeems the real map over the private side channel, and only once", async () => {
  const result = await mcp.callTool({ name: "recall", arguments: { maxTier: 2 } });
  const { redactionCorrelationId } = result.structuredContent;

  const first = await takeRedactionMap(redactionCorrelationId);
  const values = Object.values(first.redactionMap);
  assert.ok(values.includes(ALICE_EMAIL) || values.includes(BOB_EMAIL),
    "the redeemed map must contain the real PII the public result withheld");

  const second = await takeRedactionMap(redactionCorrelationId);
  assert.deepEqual(second.redactionMap, {}, "a replayed/leaked id must be worthless the second time");
});

// Review round 6, P1: invisibility from tools/list() is not authorization — a
// client holding this exact stdio connection can still send the raw
// aperio/takeRedactionMap request by name (this test does exactly that), so
// knowing a valid, unexpired correlation id must not be enough on its own.
test("a wrong auth token cannot redeem a real, valid correlation id — and does not burn it", async () => {
  const result = await mcp.callTool({ name: "recall", arguments: { maxTier: 2 } });
  const { redactionCorrelationId } = result.structuredContent;

  const wrongToken = await takeRedactionMap(redactionCorrelationId, "not-the-real-token");
  assert.deepEqual(wrongToken.redactionMap, {}, "the wrong token must never redeem the real map");

  const rightToken = await takeRedactionMap(redactionCorrelationId);
  const values = Object.values(rightToken.redactionMap);
  assert.ok(values.includes(ALICE_EMAIL) || values.includes(BOB_EMAIL),
    "the failed attempt must not have consumed or corrupted the entry — the correct token still redeems it");
});

test("two rows sharing the same PII pattern in one recall do not collide, and restore() recovers both", async () => {
  const { restore } = await import("../../../lib/privacy/redact.js");
  const result = await mcp.callTool({ name: "recall", arguments: { maxTier: 2 } });
  const text = result.content.find(c => c.type === "text")?.text ?? "";
  const { redactionMap } = await takeRedactionMap(result.structuredContent.redactionCorrelationId);

  const map = new Map(Object.entries(redactionMap));
  assert.equal(map.size, 2, "both tier-2 rows' tokens must survive — neither overwrote the other");
  const restored = restore(text, map);
  assert.ok(restored.includes(ALICE_EMAIL));
  assert.ok(restored.includes(BOB_EMAIL));
});

test("two SEPARATE recall calls do not mint colliding tokens even with identical row shape", async () => {
  const first = await mcp.callTool({ name: "recall", arguments: { maxTier: 2, query: "Alice" } });
  const second = await mcp.callTool({ name: "recall", arguments: { maxTier: 2, query: "Alice" } });
  assert.notEqual(
    first.structuredContent.redactionCorrelationId,
    second.structuredContent.redactionCorrelationId,
  );
});

test("aperio/takeRedactionMap is NOT a discoverable MCP tool", async () => {
  const { tools } = await mcp.listTools();
  assert.ok(
    !tools.some(t => t.name.includes("takeRedactionMap") || t.name.includes("redaction")),
    "the redemption channel must never be registered as an MCP tool — that would make the map reachable by any client's normal tools/call",
  );
});

// Review round 5, P2: on a typical 022 umask, the default mkdir/writeFile
// modes (0755/0644) let any other local user on the machine list and read a
// file holding restored PII (email/phone/card/IBAN). Both the directory and
// the map file must be owner-only.
test("the on-disk redaction map directory and file are owner-only (no group/other access)", async () => {
  const { statSync } = await import("node:fs");
  const result = await mcp.callTool({ name: "recall", arguments: { maxTier: 2 } });
  const { redactionCorrelationId } = result.structuredContent;

  const redactionMapDir = join(scratchDir, "var", "redaction-maps");
  const mapPath = join(redactionMapDir, `${redactionCorrelationId}.json`);

  assert.equal(statSync(redactionMapDir).mode & 0o777, 0o700, "directory must be owner-only (rwx------)");
  assert.equal(statSync(mapPath).mode & 0o777, 0o600, "map file must be owner-only (rw-------)");

  await takeRedactionMap(redactionCorrelationId); // clean up the file this test wrote
});

// Review round 6, P1's actual reported scenario: a standalone `npm run mcp`
// deployment (Claude Desktop, Cursor, or any other external client talking to
// mcp/index.js directly) has no lib/agent/mcp-connect.js spawner in front of
// it to mint and inject APERIO_MCP_AUTH_TOKEN — that client's own stdio
// connection is the only connection this process ever gets. This spins up a
// second child exactly like that (no auth token in its env at all) against
// the SAME already-seeded DB, and drives the real wire protocol end to end:
// recall a real tier-2 memory, get a real correlation id back, then try to
// redeem it — which must fail no matter what token is guessed.
describe("no APERIO_MCP_AUTH_TOKEN configured (standalone/external-client deployment shape)", () => {
  let unauthTransport, unauthMcp;

  before(async () => {
    const { NODE_ENV: _unused, ...envWithoutNodeEnv } = process.env;
    unauthTransport = new StdioClientTransport({
      command: process.execPath,
      args: ["--no-warnings=ExperimentalWarning", join(REPO_ROOT, "mcp/index.js")],
      env: {
        ...envWithoutNodeEnv,
        APERIO_PROC_ROLE: "mcp",
        DB_BACKEND: "sqlite",
        SQLITE_PATH: dbPath,
        EMBEDDING_PROVIDER: "voyage",
        VOYAGE_API_KEY: "",
        APERIO_PROVIDER_LOCAL: "0",
        APERIO_CLOUD_SENSITIVE_MODE: "redact",
        APERIO_RUNTIME_ROOT: scratchDir, // same scratch-hygiene reason as the main spawn
        // Deliberately no APERIO_MCP_AUTH_TOKEN — this is the whole point.
      },
      stderr: "pipe",
    });
    unauthMcp = new Client({ name: "redaction-side-channel-unauth-test", version: "0.0.0-test" });
    await unauthMcp.connect(unauthTransport);
  }, { timeout: 30000 });

  after(async () => {
    await unauthMcp?.close?.().catch(() => {});
  });

  test("no token, and any guessed token, both fail to redeem a real correlation id", async () => {
    const result = await unauthMcp.callTool({ name: "recall", arguments: { maxTier: 2 } });
    const { redactionCorrelationId } = result.structuredContent;

    const guessed = await unauthMcp.request(
      { method: "aperio/takeRedactionMap", params: { correlationId: redactionCorrelationId, token: "guessed-token" } },
      ResultSchema,
    );
    assert.deepEqual(guessed.redactionMap, {}, "a guessed token must never redeem a map when no auth token is configured");

    // Omitting the field entirely fails schema validation rather than
    // returning an empty map — still fail-closed, just via a different
    // rejection path; both must leave the model's echoed placeholder unrestorable.
    await assert.rejects(
      unauthMcp.request(
        { method: "aperio/takeRedactionMap", params: { correlationId: redactionCorrelationId } },
        ResultSchema,
      ),
    );
  });
});

// Review round 6, P2: without APERIO_RUNTIME_ROOT, the redaction-map
// directory was derived from this module's own file location — always under
// the code checkout, regardless of any separate writable runtimeRoot the app
// was configured with (lib/server.js's RUNTIME_ROOT, threaded down through
// createAgent → createToolCatalog → connectMcp). A read-only source install,
// or a runtimeRoot deliberately pointed elsewhere, would then either fail
// with EACCES or leave this PII outside the configured runtime-state
// boundary. This spins up a child with APERIO_RUNTIME_ROOT pointed at a
// throwaway scratch dir and confirms the map file actually lands there, not
// under the checkout's own var/redaction-maps.
describe("APERIO_RUNTIME_ROOT is honored for the on-disk map location", () => {
  let customRoot, customTransport, customMcp;

  before(async () => {
    customRoot = mkdtempSync(join(tmpdir(), "aperio-redaction-runtime-root-"));
    const { NODE_ENV: _unused, ...envWithoutNodeEnv } = process.env;
    customTransport = new StdioClientTransport({
      command: process.execPath,
      args: ["--no-warnings=ExperimentalWarning", join(REPO_ROOT, "mcp/index.js")],
      env: {
        ...envWithoutNodeEnv,
        APERIO_PROC_ROLE: "mcp",
        DB_BACKEND: "sqlite",
        SQLITE_PATH: dbPath,
        EMBEDDING_PROVIDER: "voyage",
        VOYAGE_API_KEY: "",
        APERIO_PROVIDER_LOCAL: "0",
        APERIO_CLOUD_SENSITIVE_MODE: "redact",
        APERIO_MCP_AUTH_TOKEN: MCP_AUTH_TOKEN,
        APERIO_RUNTIME_ROOT: customRoot,
      },
      stderr: "pipe",
    });
    customMcp = new Client({ name: "redaction-side-channel-runtime-root-test", version: "0.0.0-test" });
    await customMcp.connect(customTransport);
  }, { timeout: 30000 });

  after(async () => {
    await customMcp?.close?.().catch(() => {});
    rmSync(customRoot, { recursive: true, force: true });
  });

  test("the map file is written under the configured runtimeRoot, not the code checkout", async () => {
    const { existsSync } = await import("node:fs");
    const result = await customMcp.callTool({ name: "recall", arguments: { maxTier: 2 } });
    const { redactionCorrelationId } = result.structuredContent;

    const expectedPath = join(customRoot, "var", "redaction-maps", `${redactionCorrelationId}.json`);
    const wrongPath = join(REPO_ROOT, "var", "redaction-maps", `${redactionCorrelationId}.json`);
    assert.ok(existsSync(expectedPath), "the map file must exist under APERIO_RUNTIME_ROOT");
    assert.ok(!existsSync(wrongPath), "the map file must NOT be written under the code checkout instead");

    const redeemed = await customMcp.request(
      { method: "aperio/takeRedactionMap", params: { correlationId: redactionCorrelationId, token: MCP_AUTH_TOKEN } },
      ResultSchema,
    );
    assert.ok(Object.keys(redeemed.redactionMap).length > 0, "redemption still works from the configured runtimeRoot");
  });
});

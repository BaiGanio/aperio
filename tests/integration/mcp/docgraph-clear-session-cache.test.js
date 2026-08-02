// tests/integration/mcp/docgraph-clear-session-cache.test.js
//
// P1 fix verification (llamacpp-multiturn-latency.md Step 3 code review,
// round 3): the doc_batch session dedup cache (lib/docgraph/retrieval.js's
// sessionReadFacts) lives ONLY inside the MCP child process spawned by
// lib/agent/mcp-connect.js — a call from the main server's own copy of
// retrieval.js is a completely separate module instance in a completely
// separate OS process and never touches it.
//
// Round 5 finding: the FIRST fix exposed this invalidation as a normal MCP
// tool ("docgraph_clear_session_cache"), reachable via callTool() and kept
// off the model-facing schema only by omission from lib/agent/tool-
// profiles.js's TOOL_PROFILES. That omission only protects providers that go
// through Aperio's own tool-profile filtering — runClaudeCodeLoop builds its
// SDK tool list from the FULL mcpTools catalog (bypassing profile filtering
// entirely), and Codex spawns its own separate mcp/index.js child and
// discovers every tool that child registers, with no Aperio-side filtering
// at all. So the "internal" tool was actually model-callable on both. The
// fix: invalidation is now a custom, non-tool JSON-RPC method
// ("aperio/clearDocSessionCache") registered directly on the low-level
// Server in mcp/index.js — invisible to tools/list() for every client,
// since it was never part of the Tools capability to begin with.
//
// This spawns a REAL mcp/index.js child (mirroring connectMcp()'s own
// StdioClientTransport usage, and tests/e2e/helpers/test-agent.js's
// callMcpToolForReal pattern) against a real, disposable scratch SQLite DB,
// and drives doc_batch + the custom clear-cache method through the genuine
// MCP wire protocol — not direct module calls — so a regression back to a
// same-process no-op, OR back to a model-visible tool, would show up here.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

const SHA256 = "fixed-test-sha-for-clear-session-cache";
const DOC_TEXT = "ACME Utilities Co. Statement.\nAmount Due: 142.50 BGN.\nInvoice Date: 03.06.2026.";
const SESSION_ID = "mcp-integration-conv-1";

let scratchDir, dbPath, transport, mcp;

before(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "aperio-docgraph-clear-session-"));
  dbPath = join(scratchDir, "aperio.db");

  // Seed the scratch DB in a short-lived connection of THIS process, then
  // close it before the child ever opens the same file — no concurrent
  // writers, no lock contention to reason about.
  const oldPath = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = dbPath;
  const { SqliteStore } = await import("../../../db/sqlite.js");
  const seedStore = await SqliteStore.init();
  seedStore.db.exec(`INSERT INTO docgraph_repos (id, root_path) VALUES (1, '${scratchDir}')`);
  seedStore.db.prepare(`
    INSERT INTO docgraph_documents (id, repo_id, rel_path, mime, size, mtime, sha256, title)
    VALUES (1, 1, 'bill.txt', 'text/plain', ?, ?, ?, 'Bill')
  `).run(Buffer.byteLength(DOC_TEXT, "utf8"), new Date().toISOString(), SHA256);
  seedStore.db.prepare(`
    INSERT INTO docgraph_sections (id, document_id, ord, level, heading, text)
    VALUES (1, 1, 0, 1, NULL, ?)
  `).run(DOC_TEXT);
  await seedStore.close?.();
  if (oldPath) process.env.SQLITE_PATH = oldPath; else delete process.env.SQLITE_PATH;

  // mcp/index.js's execution guard skips startServer() when NODE_ENV==="test"
  // (so unit tests can import it side-effect-free) — the whole test suite
  // runs under NODE_ENV=test, so it must not leak into the spawned child.
  const { NODE_ENV: _unused, ...envWithoutNodeEnv } = process.env;
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-warnings=ExperimentalWarning", join(REPO_ROOT, "mcp/index.js")],
    env: {
      ...envWithoutNodeEnv,
      APERIO_PROC_ROLE: "mcp",
      DB_BACKEND: "sqlite",
      SQLITE_PATH: dbPath,
      // No API key — checkEmbeddingProvider/initEmbeddings no-op gracefully
      // (see tests/integration/mcp/index.test.js's own "vectorEnabled: true"
      // test) instead of loading a local transformer model or reaching the
      // network. doc_batch never touches embeddings anyway.
      EMBEDDING_PROVIDER: "voyage",
      VOYAGE_API_KEY: "",
    },
    stderr: "pipe",
  });
  mcp = new Client({ name: "docgraph-clear-session-cache-test", version: "0.0.0-test" });
  await mcp.connect(transport);
}, { timeout: 30000 });

after(async () => {
  await mcp?.close?.().catch(() => {});
  rmSync(scratchDir, { recursive: true, force: true });
});

function candidate() {
  return { id: 1, repo_id: 1, root_path: scratchDir, rel_path: "bill.txt", mime: "text/plain", sha256: SHA256 };
}

async function docBatch(sessionId) {
  const result = await mcp.callTool({
    name: "doc_batch",
    arguments: { candidates: [candidate()] },
    _meta: sessionId ? { docSessionId: sessionId } : undefined,
  });
  const text = result.content?.find(c => c.type === "text")?.text ?? "";
  assert.ok(!result.isError, `doc_batch must not error: ${text}`);
  return JSON.parse(text).documents[0];
}

function clearDocSessionCache(sessionId) {
  return mcp.request(
    { method: "aperio/clearDocSessionCache", params: { sessionId } },
    ResultSchema,
  );
}

test("doc_batch dedups a repeat read in the same session, the custom clear-cache method actually invalidates it in the CHILD process, and a following read is real again", async () => {
  const first = await docBatch(SESSION_ID);
  assert.equal(first.status, "read");
  assert.equal(first.text, DOC_TEXT, "first read must be the real document text");

  const second = await docBatch(SESSION_ID);
  assert.match(second.text, /already read/i, "a same-session repeat must be deduped to a short pointer");

  // The genuine cross-process assertion: this JSON-RPC round trip must reach
  // the SAME child process instance that is holding the dedup cache. A same-
  // process (parent) call to clearSessionFacts() would leave this cache
  // untouched and the next doc_batch would still return the pointer.
  const clearResult = await clearDocSessionCache(SESSION_ID);
  assert.equal(clearResult.ok, true);

  const third = await docBatch(SESSION_ID);
  assert.equal(
    third.text, DOC_TEXT,
    "after the clear-cache call, the SAME session must read the document in full again — proves the invalidation reached the child's real cache, not a no-op parent-process copy",
  );
});

test("clearing one session's cache does not affect a different session's dedup state", async () => {
  const otherSession = "mcp-integration-conv-2";
  await docBatch(otherSession);
  const dedupedInOther = await docBatch(otherSession);
  assert.match(dedupedInOther.text, /already read/i);

  await clearDocSessionCache("some-unrelated-session");

  const stillDeduped = await docBatch(otherSession);
  assert.match(stillDeduped.text, /already read/i, "clearing an unrelated session must not touch this session's cache");
});

test("the invalidation is NOT a discoverable MCP tool — invisible via tools/list, and tools/call reports it unknown by name", async () => {
  const { tools } = await mcp.listTools();
  assert.ok(
    !tools.some(t => t.name === "docgraph_clear_session_cache"),
    "the cache-clear operation must never be registered as an MCP tool — that would make it visible via tools/list to EVERY client (including Codex's own separate MCP client and Claude Code's SDK, which both bypass Aperio's tool-profile filtering entirely)",
  );

  // A tools/call for this name resolves (not a JSON-RPC-level rejection) but
  // as an error result reporting the tool unknown — the SDK's own "no such
  // registered tool" response, confirming it was never registered as a tool
  // at all, only as a separate custom JSON-RPC method.
  const callResult = await mcp.callTool({ name: "docgraph_clear_session_cache", arguments: { sessionId: SESSION_ID } });
  assert.equal(callResult.isError, true);
  assert.match(callResult.content?.[0]?.text ?? "", /not found/i);

  // The real invalidation channel works when called correctly, confirming
  // this isn't simply broken end to end.
  const result = await clearDocSessionCache(SESSION_ID);
  assert.equal(result.ok, true);
});

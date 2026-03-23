/**
 * Aperio MCP Tools — Integration Tests
 * Uses Node's built-in test runner (node:test). No extra dependencies needed.
 * Run: node --test tests/mcp-tools.test.js
 *
 * Tests the core tool logic directly — no MCP transport, no real DB.
 * A mock DB is injected so tests run without a Postgres connection.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Mock DB ──────────────────────────────────────────────────────────────────
// Simulates pg.Pool query responses. Each test seeds `mockRows` and `mockRowCount`
// before calling tool logic.

let mockRows = [];
let mockRowCount = 0;
let lastQuery = null;
let lastParams = null;

const mockDb = {
  query(sql, params = []) {
    lastQuery = sql;
    lastParams = params;
    return Promise.resolve({ rows: mockRows, rowCount: mockRowCount });
  },
};

// ─── Helpers under test ───────────────────────────────────────────────────────
// These are extracted from mcp/index.js and tested independently so we don't
// need to boot the full MCP server or connect to Postgres.

function embeddingToSQL(embedding) {
  return `[${embedding.join(",")}]`;
}

function isPathAllowed(filePath, allowedPaths) {
  const resolved = filePath.startsWith("~")
    ? filePath.replace("~", process.cwd())
    : filePath;
  return allowedPaths.some((allowed) => {
    const base = allowed.endsWith("/") ? allowed : allowed + "/";
    return resolved.startsWith(base) || resolved === allowed;
  });
}

// ─── Tool logic extracted for testing ────────────────────────────────────────
// Each function mirrors the handler in mcp/index.js but accepts `db` as a
// parameter instead of closing over the module-level singleton.

async function rememberTool(db, { type, title, content, tags, importance, expires_at }, embedding = null) {
  const result = await db.query(
    `INSERT INTO memories (type, title, content, tags, importance, expires_at, source, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, title, type`,
    [
      type, title, content,
      tags ?? [], importance ?? 3, expires_at ?? null,
      "test",
      embedding ? embeddingToSQL(embedding) : null,
    ]
  );
  const mem = result.rows[0];
  const embeddingNote = embedding ? " (with semantic embedding)" : "";
  return {
    content: [{ type: "text", text: `✅ Memory saved [${mem.type}] "${mem.title}"${embeddingNote} (id: ${mem.id})` }],
  };
}

async function forgetTool(db, { id }) {
  const result = await db.query(`DELETE FROM memories WHERE id = $1 RETURNING title`, [id]);
  if (!result.rowCount) return { content: [{ type: "text", text: `❌ No memory found: ${id}` }] };
  return { content: [{ type: "text", text: `🗑️ Forgotten: "${result.rows[0].title}"` }] };
}

async function updateMemoryTool(db, { id, title, content, tags, importance }, vectorEnabled = false) {
  const current = await db.query(`SELECT title, content FROM memories WHERE id = $1`, [id]);
  if (!current.rowCount) return { content: [{ type: "text", text: `❌ No memory found: ${id}` }] };

  const fields = [], params = [];
  let idx = 1;
  if (title)      { fields.push(`title = $${idx++}`);      params.push(title); }
  if (content)    { fields.push(`content = $${idx++}`);    params.push(content); }
  if (tags)       { fields.push(`tags = $${idx++}`);       params.push(tags); }
  if (importance) { fields.push(`importance = $${idx++}`); params.push(importance); }
  if (!fields.length) return { content: [{ type: "text", text: "❌ No fields to update." }] };

  params.push(id);
  const result = await db.query(
    `UPDATE memories SET ${fields.join(", ")} WHERE id = $${idx} RETURNING title`, params
  );
  return { content: [{ type: "text", text: `✅ Updated: "${result.rows[0].title}"` }] };
}

async function recallTool(db, { query, type, tags, limit: _limit }, vectorEnabled = false) {
  const maxResults = _limit ?? 10;
  let rows = [];

  // Semantic path skipped in unit tests (no embedding provider) — falls through to full-text
  if (!rows.length) {
    let conditions = ["(expires_at IS NULL OR expires_at > now())"];
    let params = [];
    let idx = 1;
    if (type) { conditions.push(`type = $${idx++}`); params.push(type); }
    if (tags?.length > 0) { conditions.push(`tags && $${idx++}`); params.push(tags); }
    if (query) {
      conditions.push(`to_tsvector('english', title || ' ' || content) @@ plainto_tsquery('english', $${idx++})`);
      params.push(query);
    }
    params.push(maxResults);
    const result = await db.query(
      `SELECT id, type, title, content, tags, importance, created_at
       FROM memories WHERE ${conditions.join(" AND ")}
       ORDER BY importance DESC, created_at DESC LIMIT $${idx}`,
      params
    );
    rows = result.rows;
  }

  if (!rows.length) return { content: [{ type: "text", text: "No memories found." }] };

  const formatted = rows.map((m) =>
    `[${m.type.toUpperCase()}] ${m.title} (importance: ${m.importance})\n${m.content}\nTags: ${(m.tags || []).join(", ") || "none"}\nID: ${m.id}`
  ).join("\n---\n");

  return { content: [{ type: "text", text: formatted }] };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("embeddingToSQL", () => {
  test("formats a float array as pgvector literal", () => {
    const result = embeddingToSQL([0.1, 0.2, 0.3]);
    assert.equal(result, "[0.1,0.2,0.3]");
  });

  test("handles single-element array", () => {
    assert.equal(embeddingToSQL([1]), "[1]");
  });

  test("handles empty array", () => {
    assert.equal(embeddingToSQL([]), "[]");
  });
});

describe("isPathAllowed", () => {
  const allowed = ["/home/user/projects", "/tmp/aperio"];

  test("allows path within an allowed directory", () => {
    assert.ok(isPathAllowed("/home/user/projects/aperio/file.js", allowed));
  });

  test("blocks path outside allowed directories", () => {
    assert.ok(!isPathAllowed("/etc/passwd", allowed));
  });

  test("allows second allowed path", () => {
    assert.ok(isPathAllowed("/tmp/aperio/test.txt", allowed));
  });

  test("blocks path that is a prefix but not a subpath", () => {
    assert.ok(!isPathAllowed("/home/user/projects-evil/file.js", allowed));
  });

  test("expands ~ to cwd", () => {
    const cwd = process.cwd();
    assert.ok(isPathAllowed("~/file.js", [cwd]));
  });
});

describe("remember tool", () => {
  beforeEach(() => {
    mockRows = [{ id: "abc-123", type: "fact", title: "Test memory" }];
    mockRowCount = 1;
  });

  test("saves a memory and returns confirmation", async () => {
    const result = await rememberTool(mockDb, {
      type: "fact",
      title: "Test memory",
      content: "Some content",
    });
    assert.ok(result.content[0].text.includes("✅ Memory saved"));
    assert.ok(result.content[0].text.includes("Test memory"));
    assert.ok(result.content[0].text.includes("abc-123"));
  });

  test("notes when embedding is present", async () => {
    const result = await rememberTool(mockDb, {
      type: "preference",
      title: "Likes TypeScript",
      content: "Prefers TypeScript over JavaScript",
    }, [0.1, 0.2, 0.3]);
    assert.ok(result.content[0].text.includes("with semantic embedding"));
  });

  test("does not note embedding when absent", async () => {
    const result = await rememberTool(mockDb, {
      type: "fact",
      title: "Plain fact",
      content: "No embedding",
    });
    assert.ok(!result.content[0].text.includes("with semantic embedding"));
  });

  test("uses correct INSERT query", async () => {
    await rememberTool(mockDb, {
      type: "decision",
      title: "Use pgvector",
      content: "Decided to use pgvector for semantic search",
      tags: ["infra", "db"],
      importance: 4,
    });
    assert.ok(lastQuery.includes("INSERT INTO memories"));
    assert.equal(lastParams[0], "decision");
    assert.equal(lastParams[1], "Use pgvector");
    assert.deepEqual(lastParams[3], ["infra", "db"]);
    assert.equal(lastParams[4], 4);
  });

  test("defaults importance to 3 when not provided", async () => {
    await rememberTool(mockDb, { type: "fact", title: "T", content: "C" });
    assert.equal(lastParams[4], 3);
  });
});

describe("forget tool", () => {
  test("deletes a memory and returns confirmation", async () => {
    mockRows = [{ title: "Old preference" }];
    mockRowCount = 1;
    const result = await forgetTool(mockDb, { id: "abc-123" });
    assert.ok(result.content[0].text.includes("🗑️ Forgotten"));
    assert.ok(result.content[0].text.includes("Old preference"));
  });

  test("returns error when memory not found", async () => {
    mockRows = [];
    mockRowCount = 0;
    const result = await forgetTool(mockDb, { id: "nonexistent-id" });
    assert.ok(result.content[0].text.includes("❌ No memory found"));
  });

  test("passes the correct id to the DELETE query", async () => {
    mockRows = [{ title: "X" }];
    mockRowCount = 1;
    await forgetTool(mockDb, { id: "test-uuid-999" });
    assert.ok(lastQuery.includes("DELETE FROM memories"));
    assert.equal(lastParams[0], "test-uuid-999");
  });
});

describe("update_memory tool", () => {
  beforeEach(() => {
    // First call: SELECT to get current row. Second call: UPDATE returning title.
    // mockDb.query always returns the same mock, so we set rows to satisfy both.
    mockRows = [{ title: "Original title", content: "Original content" }];
    mockRowCount = 1;
  });

  test("updates title and returns confirmation", async () => {
    const result = await updateMemoryTool(mockDb, {
      id: "abc-123",
      title: "New title",
    });
    assert.ok(result.content[0].text.includes("✅ Updated"));
    assert.ok(result.content[0].text.includes("Original title")); // mock returns same row
  });

  test("returns error when no fields provided", async () => {
    const result = await updateMemoryTool(mockDb, { id: "abc-123" });
    assert.ok(result.content[0].text.includes("❌ No fields to update"));
  });

  test("returns error when memory not found", async () => {
    mockRows = [];
    mockRowCount = 0;
    const result = await updateMemoryTool(mockDb, { id: "missing", title: "X" });
    assert.ok(result.content[0].text.includes("❌ No memory found"));
  });

  test("builds correct SET clause for multiple fields", async () => {
    mockRows = [{ title: "T", content: "C" }];
    mockRowCount = 1;
    await updateMemoryTool(mockDb, {
      id: "abc-123",
      title: "New title",
      importance: 5,
    });
    assert.ok(lastQuery.includes("UPDATE memories SET"));
    assert.ok(lastQuery.includes("title ="));
    assert.ok(lastQuery.includes("importance ="));
  });
});

describe("recall tool", () => {
  test("returns formatted memories", async () => {
    mockRows = [{
      id: "abc-123", type: "fact", title: "Test fact",
      content: "Some content", tags: ["test"], importance: 3,
      created_at: new Date(),
    }];
    mockRowCount = 1;
    const result = await recallTool(mockDb, { query: "test" });
    assert.ok(result.content[0].text.includes("[FACT]"));
    assert.ok(result.content[0].text.includes("Test fact"));
    assert.ok(result.content[0].text.includes("abc-123"));
  });

  test("returns no memories message when empty", async () => {
    mockRows = [];
    mockRowCount = 0;
    const result = await recallTool(mockDb, { query: "nothing" });
    assert.equal(result.content[0].text, "No memories found.");
  });

  test("applies type filter in query", async () => {
    mockRows = [];
    mockRowCount = 0;
    await recallTool(mockDb, { type: "preference" });
    assert.ok(lastQuery.includes("type = "));
    assert.ok(lastParams.includes("preference"));
  });

  test("applies tags filter in query", async () => {
    mockRows = [];
    mockRowCount = 0;
    await recallTool(mockDb, { tags: ["typescript"] });
    assert.ok(lastQuery.includes("tags &&"));
    assert.ok(lastParams.some(p => Array.isArray(p) && p.includes("typescript")));
  });

  test("respects limit parameter", async () => {
    mockRows = [];
    mockRowCount = 0;
    await recallTool(mockDb, { limit: 5 });
    assert.ok(lastParams.includes(5));
  });

  test("formats multiple memories with --- separator", async () => {
    mockRows = [
      { id: "1", type: "fact", title: "First", content: "A", tags: [], importance: 3, created_at: new Date() },
      { id: "2", type: "preference", title: "Second", content: "B", tags: [], importance: 4, created_at: new Date() },
    ];
    mockRowCount = 2;
    const result = await recallTool(mockDb, {});
    assert.ok(result.content[0].text.includes("---"));
  });

  test("handles memories with no tags gracefully", async () => {
    mockRows = [{ id: "1", type: "fact", title: "T", content: "C", tags: [], importance: 3, created_at: new Date() }];
    mockRowCount = 1;
    const result = await recallTool(mockDb, {});
    assert.ok(result.content[0].text.includes("Tags: none"));
  });
});
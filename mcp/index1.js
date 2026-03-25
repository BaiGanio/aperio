import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve, join, extname, basename } from "path";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import fs from "fs/promises";

// ─── Load .env ────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

// ─── Clients ──────────────────────────────────────────────────────────────────
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  await db.query("SELECT 1");
  console.error("✅ Connected to Aperio database");
} catch (err) {
  console.error("❌ Database connection failed:", err.message);
  process.exit(1);
}

// ─── Path safety ──────────────────────────────────────────────────────────────
const ALLOWED_PATHS = (process.env.APERIO_ALLOWED_PATHS || process.cwd())
  .split(",")
  .map(p => p.trim().replace(/^~/, process.cwd()));

function isPathAllowed(filePath) {
  const resolved = filePath.startsWith("~")
    ? filePath.replace("~", process.cwd())
    : filePath;
  return ALLOWED_PATHS.some(allowed => resolved.startsWith(allowed + "/") || resolved === allowed);
}

// ─── Warning: Path safety - tools can access any absolute path on your machine ─────────
// const ALLOWED_PATHS = (process.env.APERIO_ALLOWED_PATHS || process.env.HOME || "/root")
//   .split(",")
//   .map(p => p.trim().replace(/^~/, process.env.HOME || "/root"));

// function isPathAllowed(filePath) {
//   const resolved = filePath.startsWith("~")
//     ? filePath.replace("~", process.env.HOME || "/root")
//     : filePath;
//   return ALLOWED_PATHS.some(allowed => resolved.startsWith(allowed + "/") || resolved === allowed);
// }

// ─── Embeddings ───────────────────────────────────────────────────────────────
let vectorEnabled = true;
const { rows: embRows } = await db.query("SELECT COUNT(*) as c FROM memories WHERE embedding IS NOT NULL");
const embCount = parseInt(embRows[0].c);
const { rows: totalRows } = await db.query("SELECT COUNT(*) as c FROM memories");
const total = parseInt(totalRows[0].c);
if (embCount === 0) {
  console.error(`✅ pgvector enabled — ⚠️  no embeddings yet (${total} memories) — using full-text search.`);
  console.error(`✅ pgvector enabled — ⚠️  Call 'backfill my embeddings' to generate embeddings for existing memories.`);
} else {
  console.error(`✅ pgvector enabled — semantic search active (${embCount}/${total} memories embedded)`);
}

async function generateEmbedding(text, inputType = "document") {
  if (!vectorEnabled) return null;

  const provider = (process.env.EMBEDDING_PROVIDER || "voyage").toLowerCase();

  // ─── Ollama (fully local, air-gapped) ──────────────────────────────────────
  if (provider === "ollama") {
    const model = process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text";
    // console.error("🔍 embedding model:", model, "| provider:", provider);
    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    // console.error("🔍 embedding model:", model, "| base:", baseUrl);
    try {
      const response = await fetch(`${baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: text }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      //console.error("🔍 embed raw:", JSON.stringify(data).substring(0, 300));
      return data.embeddings?.[0];
    } catch (err) {
      console.error("⚠️  Ollama embedding failed:", err.message, "| model:", model, "| url:", baseUrl);
      return null;
    }
  }

  // ─── Voyage AI (default) ────────────────────────────────────────────────────
  if (!process.env.VOYAGE_API_KEY) {
    console.error("⚠️  VOYAGE_API_KEY not set — skipping embedding");
    return null;
  }
  try {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "voyage-3",
        input: [text],
        input_type: inputType,
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.data[0].embedding;
  } catch (err) {
    console.error("⚠️  Voyage embedding failed:", err.message);
    return null;
  }
}

function embeddingToSQL(embedding) {
  return `[${embedding.join(",")}]`;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────
const server = new McpServer({ name: "aperio", version: "2.0.0" });

// ─── TOOL: remember ───────────────────────────────────────────────────────────
server.registerTool(
  "remember",
  {
    description: "Save a new memory to Aperio. Automatically generates embeddings for semantic search.",
    inputSchema: z.object({
      type: z.enum(["fact", "preference", "project", "decision", "solution", "source", "person"]).describe("Category of memory"),
      title: z.string().describe("Short label for this memory"),
      content: z.string().describe("Full memory in plain English"),
      tags: z.array(z.string()).optional().describe("Optional tags"),
      importance: z.number().min(1).max(5).optional().describe("1=low to 5=high, default 3"),
      expires_at: z.string().optional().describe("Optional ISO date when this memory expires"),
    }),
  },
  async ({ type, title, content, tags, importance, expires_at }) => {
    const textToEmbed = `${title}. ${content}`;
    const embedding = await generateEmbedding(textToEmbed);

    const result = await db.query(
      `INSERT INTO memories (type, title, content, tags, importance, expires_at, source, embedding)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, title, type`,
      [
        type, title, content,
        tags ?? [], importance ?? 3, expires_at ?? null,
        process.env.AI_PROVIDER === "ollama" ? (process.env.OLLAMA_MODEL || "ollama") : (process.env.ANTHROPIC_MODEL || "claude"),
        embedding ? embeddingToSQL(embedding) : null,
      ]
    );
    const mem = result.rows[0];
    const embeddingNote = embedding ? " (with semantic embedding)" : "";
    return {
      content: [{ type: "text", text: `✅ Memory saved [${mem.type}] "${mem.title}"${embeddingNote} (id: ${mem.id})` }],
    };
  }
);

// ─── TOOL: recall ─────────────────────────────────────────────────────────────
server.registerTool(
  "recall",
  {
    description: "Search memories. Uses semantic similarity search when a query is provided (finds related concepts, not just matching words). Falls back to full-text search if needed.",
    inputSchema: z.object({
      query: z.string().optional().describe("Natural language search — finds semantically related memories"),
      type: z.enum(["fact", "preference", "project", "decision", "solution", "source", "person"]).optional().describe("Filter by type"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
      limit: z.number().min(1).max(50).optional().describe("Max results, default 10"),
      search_mode: z.enum(["semantic", "fulltext", "auto"]).optional().describe("Force search mode. Default: auto (semantic if available)"),
    }),
  },
  async ({ query, type, tags, limit: _limit, search_mode = "auto" }) => {
    const limit = _limit !== undefined ? parseInt(_limit, 10) : undefined;
    const maxResults = limit ?? 10;
    let rows = [];

    const useSemanticSearch =
      query &&
      vectorEnabled &&
      (search_mode === "semantic" || search_mode === "auto");

    if (useSemanticSearch) {
      const queryEmbedding = await generateEmbedding(query, "query");
      if (queryEmbedding) {
        let conditions = ["(expires_at IS NULL OR expires_at > now())", "embedding IS NOT NULL"];
        let params = [embeddingToSQL(queryEmbedding)];
        let idx = 2;

        if (type)             { conditions.push(`type = $${idx++}`);  params.push(type); }
        if (tags?.length > 0) { conditions.push(`tags && $${idx++}`); params.push(tags); }

        params.push(maxResults);
        const result = await db.query(
          `SELECT id, type, title, content, tags, importance, created_at,
                  1 - (embedding <=> $1::vector) AS similarity
           FROM memories
           WHERE ${conditions.join(" AND ")}
           ORDER BY embedding <=> $1::vector
           LIMIT $${idx}`,
          params
        );
        rows = result.rows;
      }
    }

    if (!rows.length) {
      let conditions = ["(expires_at IS NULL OR expires_at > now())"];
      let params = [];
      let idx = 1;

      if (type)             { conditions.push(`type = $${idx++}`);  params.push(type); }
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

    if (!rows.length)
      return { content: [{ type: "text", text: "No memories found." }] };

    const searchMode = useSemanticSearch && rows[0]?.similarity !== undefined
      ? "semantic" : "full-text";
    console.log(`🔍 recall: ${useSemanticSearch ? "semantic" : "full-text"} | results: ${rows.length}`);
    const formatted = rows.map(m => {
      const simNote = m.similarity !== undefined
        ? ` [similarity: ${(m.similarity * 100).toFixed(0)}%]` : "";
      return `[${m.type.toUpperCase()}] ${m.title}${simNote} (importance: ${m.importance})\n${m.content}\nTags: ${(m.tags||[]).join(", ")||"none"}\nID: ${m.id}`;
    }).join("\n---\n");

    return {
      content: [{
        type: "text",
        text: `${formatted}`
      }]
    };
  }
);

// ─── TOOL: update_memory ──────────────────────────────────────────────────────
server.registerTool(
  "update_memory",
  {
    description: "Update an existing memory by ID. Regenerates embedding if content changes.",
    inputSchema: z.object({
      id: z.string().uuid().describe("UUID of the memory to update"),
      title: z.string().optional(),
      content: z.string().optional(),
      tags: z.array(z.string()).optional(),
      importance: z.number().min(1).max(5).optional(),
    }),
  },
  async ({ id, title, content, tags, importance }) => {
    const current = await db.query(`SELECT title, content FROM memories WHERE id = $1`, [id]);
    if (!current.rowCount) return { content: [{ type: "text", text: `❌ No memory found: ${id}` }] };

    const fields = [], params = [];
    let idx = 1;
    if (title)      { fields.push(`title = $${idx++}`);      params.push(title); }
    if (content)    { fields.push(`content = $${idx++}`);    params.push(content); }
    if (tags)       { fields.push(`tags = $${idx++}`);       params.push(tags); }
    if (importance) { fields.push(`importance = $${idx++}`); params.push(importance); }
    if (!fields.length) return { content: [{ type: "text", text: "❌ No fields to update." }] };

    if ((title || content) && vectorEnabled) {
      const newTitle   = title   ?? current.rows[0].title;
      const newContent = content ?? current.rows[0].content;
      const embedding  = await generateEmbedding(`${newTitle}. ${newContent}`);
      if (embedding) {
        fields.push(`embedding = $${idx++}`);
        params.push(embeddingToSQL(embedding));
      }
    }

    params.push(id);
    const result = await db.query(
      `UPDATE memories SET ${fields.join(", ")} WHERE id = $${idx} RETURNING title`, params
    );
    return { content: [{ type: "text", text: `✅ Updated: "${result.rows[0].title}"` }] };
  }
);

// ─── TOOL: forget ─────────────────────────────────────────────────────────────
server.registerTool(
  "forget",
  {
    description: "Delete a memory from Aperio by ID",
    inputSchema: z.object({ id: z.string().uuid().describe("UUID of the memory to delete") }),
  },
  async ({ id }) => {
    const result = await db.query(`DELETE FROM memories WHERE id = $1 RETURNING title`, [id]);
    if (!result.rowCount) return { content: [{ type: "text", text: `❌ No memory found: ${id}` }] };
    return { content: [{ type: "text", text: `🗑️ Forgotten: "${result.rows[0].title}"` }] };
  }
);

// ─── TOOL: backfill_embeddings ────────────────────────────────────────────────
server.registerTool(
  "backfill_embeddings",
  {
    description: "Generate embeddings for all memories that don't have one yet. Run this once after enabling pgvector.",
    inputSchema: z.object({
      limit: z.number().min(1).max(100).optional().describe("Max memories to backfill at once, default 20"),
    }),
  },
  async ({ limit = 20 }) => {
    if (!vectorEnabled) return { content: [{ type: "text", text: "❌ pgvector not enabled." }] };

    const result = await db.query(
      `SELECT id, title, content FROM memories WHERE embedding IS NULL LIMIT $1`, [limit]
    );

    if (!result.rowCount)
      return { content: [{ type: "text", text: "✅ All memories already have embeddings!" }] };

    let success = 0, failed = 0;
    for (const row of result.rows) {
      const embedding = await generateEmbedding(`${row.title}. ${row.content}`);
      if (embedding) {
        await db.query(`UPDATE memories SET embedding = $1 WHERE id = $2`,
          [embeddingToSQL(embedding), row.id]);
        success++;
      } else {
        failed++;
      }
    }

    return {
      content: [{
        type: "text",
        text: `✅ Backfill complete: ${success} embedded, ${failed} failed. ${result.rowCount - success - failed} remaining.`
      }]
    };
  }
);

// ─── TOOL: read_file ──────────────────────────────────────────────────────────
const ALLOWED_EXTENSIONS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".py", ".go", ".rs", ".java",
  ".json", ".yaml", ".yml", ".toml", ".md", ".txt", ".html",
  ".css", ".sql", ".sh", ".env.example"
]);
const READ_FILE_CHUNK_SIZE = 500;   // max lines per read_file call
const READ_FILE_MAX_OFFSET = 10_000; // safety ceiling for chunked reads

server.registerTool(
  "read_file",
  {
    description: "Read a file from disk. Max 500 lines. Only reads code and text files.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to the file"),
       max_lines: z.number().min(1).max(READ_FILE_CHUNK_SIZE).optional()
        .describe(`Max lines to read, default ${READ_FILE_CHUNK_SIZE}`),
      offset: z.number().min(0).max(READ_FILE_MAX_OFFSET).optional()
        .describe("Line number to start reading from, default 0"),
    }),
  },
  async ({ path: filePath, max_lines, offset = 0 }) => {
    const ext = extname(filePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext))
      return { content: [{ type: "text", text: `❌ File type not allowed: ${ext}` }] };
    if (!existsSync(filePath))
      return { content: [{ type: "text", text: `❌ File not found: ${filePath}` }] };
    const stat = statSync(filePath);
    if (stat.size > 500_000)
      return { content: [{ type: "text", text: `❌ File too large (${Math.round(stat.size / 1024)}KB). Max 500KB.` }] };

    const lines = readFileSync(filePath, "utf-8").split("\n");
    const limit = Math.min(max_lines ?? READ_FILE_CHUNK_SIZE, READ_FILE_CHUNK_SIZE);

    // WHY: clamp offset so we never read past the safety ceiling or end of file
    const start = Math.min(offset, lines.length, READ_FILE_MAX_OFFSET);
    const end = start + limit;
    const chunk = lines.slice(start, end);
    const truncated = end < lines.length;

    return {
      content: [{
        type: "text",
        text: `📄 ${filePath} (${lines.length} lines):\n\n${chunk.join("\n")}${truncated ? `\n\n⚠️ Truncated at line ${end}. Use offset: ${end} to continue.` : ""}`
      }]
    };
  }
);

// ─── TOOL: scan_project ───────────────────────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", "__pycache__", ".venv", "venv"]);
const KEY_FILES = new Set(["package.json", "README.md", "readme.md", "pyproject.toml", "Cargo.toml", "go.mod", "docker-compose.yml"]);
const CODE_EXTS = new Set([".js", ".ts", ".py", ".go", ".rs", ".java", ".jsx", ".tsx"]);

server.registerTool(
  "scan_project",
  {
    description: "Scan a project folder. Returns file tree + reads key files. Skips node_modules, .git, build folders.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to the project root"),
      read_key_files: z.boolean().optional().describe("Read key file contents, default true"),
    }),
  },
  async ({ path: projectPath, read_key_files = true }) => {
    if (!existsSync(projectPath))
      return { content: [{ type: "text", text: `❌ Path not found: ${projectPath}` }] };
    if (!statSync(projectPath).isDirectory())
      return { content: [{ type: "text", text: `❌ Not a directory: ${projectPath}` }] };

    let fileCount = 0;
    const keyFileContents = [];

    function buildTree(dir, depth = 0) {
      if (depth > 3 || fileCount > 50) return "";
      let tree = "";
      let entries;
      try { entries = readdirSync(dir); } catch { return ""; }
      for (const entry of entries.sort()) {
        if (fileCount > 50) { tree += `${"  ".repeat(depth)}...\n`; break; }
        const fullPath = join(dir, entry);
        let s;
        try { s = statSync(fullPath); } catch { continue; }
        if (s.isDirectory()) {
          if (SKIP_DIRS.has(entry)) continue;
          tree += `${"  ".repeat(depth)}📁 ${entry}/\n`;
          tree += buildTree(fullPath, depth + 1);
        } else {
          fileCount++;
          const icon = CODE_EXTS.has(extname(entry).toLowerCase()) ? "📄" : "📋";
          tree += `${"  ".repeat(depth)}${icon} ${entry}\n`;
          if (read_key_files && KEY_FILES.has(entry)) {
            try {
              const content = readFileSync(fullPath, "utf-8").split("\n").slice(0, 100).join("\n");
              keyFileContents.push(`\n--- ${entry} ---\n${content}`);
            } catch {}
          }
        }
      }
      return tree;
    }

    const tree = buildTree(projectPath);
    let output = `🗂️ Project: ${basename(projectPath)}\nPath: ${projectPath}\nFiles: ${fileCount}\n\n${tree}`;
    if (keyFileContents.length) output += `\n\n📋 Key files:${keyFileContents.join("\n")}`;
    output += `\n\n💡 Use read_file to dive into specific files.`;
    return { content: [{ type: "text", text: output }] };
  }
);

// ─── TOOL: fetch_url ──────────────────────────────────────────────────────────
server.registerTool(
  "fetch_url",
  {
    description: "Fetch content from a URL. Strips HTML, truncates at 15,000 characters.",
    inputSchema: z.object({
      url: z.string().url().describe("The URL to fetch"),
      max_chars: z.number().min(500).max(15000).optional().describe("Max characters, default 15000"),
    }),
  },
  async ({ url, max_chars: _max_chars }) => {
    const max_chars = _max_chars !== undefined ? parseInt(_max_chars, 10) : undefined;
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Aperio/2.0" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        return { content: [{ type: "text", text: `❌ HTTP ${response.status}: ${response.statusText}` }] };

      let text = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("html")) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/\s{3,}/g, "\n\n").trim();
      }
      const limit = Math.min(max_chars ?? 15_000, 15_000);
      const truncated = text.length > limit;
      return {
        content: [{
          type: "text",
          text: `🌐 ${url}\n\n${text.slice(0, limit)}${truncated ? "\n\n⚠️ Truncated. Ask for more if needed." : ""}`
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Fetch failed: ${err.message}` }] };
    }
  }
);

// ─── TOOL: dedup_memories ─────────────────────────────────────────────────────
server.registerTool(
  "dedup_memories",
  {
    description: "Find near-duplicate memories using pgvector cosine similarity. In dry_run mode just reports duplicates. When dry_run=false, merges them.",
    inputSchema: z.object({
      threshold: z.number().min(0.5).max(1.0).optional().describe("Similarity threshold 0-1, default 0.97"),
      dry_run: z.boolean().optional().describe("If true, only report duplicates without merging. Default true."),
    }),
  },
  async ({ threshold = 0.97, dry_run = true }) => {
    if (!vectorEnabled)
      return { content: [{ type: "text", text: "❌ pgvector not enabled — dedup requires embeddings." }] };

    const result = await db.query(
      `SELECT
         a.id AS id_a, a.title AS title_a, a.type AS type_a,
         b.id AS id_b, b.title AS title_b, b.type AS type_b,
         1 - (a.embedding <=> b.embedding) AS similarity
       FROM memories a
       JOIN memories b ON a.id < b.id
       WHERE a.embedding IS NOT NULL
         AND b.embedding IS NOT NULL
         AND 1 - (a.embedding <=> b.embedding) >= $1
       ORDER BY similarity DESC
       LIMIT 20`,
      [threshold]
    );

    if (!result.rows.length)
      return { content: [{ type: "text", text: `✅ No duplicates found above ${(threshold * 100).toFixed(0)}% similarity.` }] };

    let report = `Found ${result.rows.length} near-duplicate pair(s):\n\n`;
    let merged = 0;

    for (const row of result.rows) {
      report += `[${(row.similarity * 100).toFixed(1)}% similar]\n`;
      report += `  A: [${row.type_a}] "${row.title_a}" (${row.id_a})\n`;
      report += `  B: [${row.type_b}] "${row.title_b}" (${row.id_b})\n\n`;

      if (!dry_run) {
        const details = await db.query(
          `SELECT content FROM memories WHERE id = $1`, [row.id_b]
        );
        const contentB = details.rows[0]?.content || "";
        const detailsA = await db.query(
          `SELECT content FROM memories WHERE id = $1`, [row.id_a]
        );
        const contentA = detailsA.rows[0]?.content || "";

        if (contentB && !contentA.includes(contentB.slice(0, 40))) {
          await db.query(
            `UPDATE memories SET content = content || ' | ' || $1 WHERE id = $2`,
            [contentB, row.id_a]
          );
        }
        await db.query(`DELETE FROM memories WHERE id = $1`, [row.id_b]);
        merged++;
      }
    }

    if (!dry_run) {
      report += `\n🧹 Merged ${merged} duplicate(s).`;
    } else {
      report += `Run with dry_run=false to merge these automatically.`;
    }

    return { content: [{ type: "text", text: report }] };
  }
);

// ─── TOOL: write_file ─────────────────────────────────────────────────────────
server.registerTool(
  "write_file",
  {
    description: "Write content to a file on disk. Creates the file if it doesn't exist, overwrites if it does. Use read_file first to inspect before editing.",
    inputSchema: z.object({
      path: z.string().describe("Absolute or ~ path to the file to write"),
      content: z.string().describe("Full content to write to the file"),
      create_dirs: z.boolean().optional().describe("Create parent directories if they don't exist. Default true."),
    }),
  },
  async ({ path: filePath, content, create_dirs = true }) => {
    try {
      const resolved = filePath.startsWith("~")
        ? filePath.replace("~", process.cwd())
        // ? filePath.replace("~", process.env.HOME || "/root") // Warning: Path safety - this allows access to the entire home directory.
        : filePath;

      if (!isPathAllowed(filePath)) {
        return { content: [{ type: "text", text: `❌ Path not allowed: ${resolved}\nAllowed paths: ${ALLOWED_PATHS.join(", ")}\nSet APERIO_ALLOWED_PATHS in .env to configure.` }] };
      }

      if (create_dirs) {
        const dir = resolved.substring(0, resolved.lastIndexOf("/"));
        if (dir) await fs.mkdir(dir, { recursive: true });
      }

      let existingSize = null;
      try {
        const stat = await fs.stat(resolved);
        existingSize = stat.size;
      } catch { /* file doesn't exist yet */ }

      await fs.writeFile(resolved, content, "utf8");

      const sizeKb = (Buffer.byteLength(content, "utf8") / 1024).toFixed(1);
      const msg = existingSize !== null
        ? `✅ Overwrote ${resolved} (${sizeKb} KB, was ${(existingSize / 1024).toFixed(1)} KB)`
        : `✅ Created ${resolved} (${sizeKb} KB)`;

      return { content: [{ type: "text", text: msg }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ write_file failed: ${err.message}` }] };
    }
  }
);

// ─── TOOL: append_file ────────────────────────────────────────────────────────
server.registerTool(
  "append_file",
  {
    description: "Append content to the end of an existing file without touching the rest. Use this for 'add to', 'append', 'write at the bottom' requests. Returns before/after line count and the last 5 lines as proof.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to the file"),
      content: z.string().describe("Content to append (added at the end of the file)"),
    }),
  },
  async ({ path: filePath, content }) => {
    try {
      const resolved = filePath.startsWith("~")
        ? filePath.replace("~", process.cwd())
        // ? filePath.replace("~", process.env.HOME || "/root") // Warning: Path safety - this allows access to the entire home directory.
        : filePath;

      if (!isPathAllowed(filePath)) {
        return { content: [{ type: "text", text: `❌ Path not allowed: ${resolved}\nAllowed paths: ${ALLOWED_PATHS.join(", ")}\nSet APERIO_ALLOWED_PATHS in .env to configure.` }] };
      }

      if (!existsSync(resolved))
        return { content: [{ type: "text", text: `❌ File not found: ${resolved}` }] };

      const before = (await fs.readFile(resolved, "utf8")).split("\n");
      await fs.appendFile(resolved, content, "utf8");
      const after = (await fs.readFile(resolved, "utf8")).split("\n");

      const tail = after.slice(-5).join("\n");
      return {
        content: [{ type: "text", text: `✅ Appended to ${resolved}\nWas ${before.length} lines → now ${after.length} lines\n\nLast 5 lines:\n${tail}` }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ append_file failed: ${err.message}` }] };
    }
  }
);

// ─── Start server ─────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("🧠 Aperio MCP server v2.0 running");
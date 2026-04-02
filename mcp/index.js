import { McpServer }          from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv                   from "dotenv";
import { fileURLToPath }        from "url";
import { dirname, resolve }     from "path";
import { getStore }             from "../db/index.js";

import { register as registerMemory }  from "./tools/memory.js";
import { register as registerFiles }   from "./tools/files.js";
import { register as registerWeb }     from "./tools/web.js";
import { register as registerImage }   from "./tools/image.js";

// ─── Load .env ────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

// ─── DB ───────────────────────────────────────────────────────────────────────
const store = await getStore();
if (!store) {
  console.error("❌ MCP Error: Store failed to initialize.");
  process.exit(1);
}

// ─── Embeddings ───────────────────────────────────────────────────────────────
const { total, embedded: embCount } = await store.counts();
console.error(`📊 Database Stats: ${total} total, ${embCount} embedded`);

let vectorEnabled = true;

async function generateEmbedding(text, inputType = "document") {
  if (!vectorEnabled) return null;

  const provider = (process.env.EMBEDDING_PROVIDER || "voyage").toLowerCase();

  if (provider === "ollama") {
    const model   = process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text";
    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    try {
      const res  = await fetch(`${baseUrl}/api/embed`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ model, input: text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const vec  = data.embeddings?.[0] ?? data.embedding ?? null;
      if (!Array.isArray(vec) || vec.length === 0) {
        console.error("⚠️  Ollama returned unexpected embedding shape:", JSON.stringify(data).slice(0, 120));
        return null;
      }
      return vec;
    } catch (err) {
      console.error("⚠️  Ollama embedding failed:", err.message);
      return null;
    }
  }

  if (!process.env.VOYAGE_API_KEY) {
    console.error("⚠️  VOYAGE_API_KEY not set — skipping embedding");
    return null;
  }
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.VOYAGE_API_KEY}` },
      body:    JSON.stringify({ model: "voyage-3", input: [text], input_type: inputType }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.data[0].embedding;
  } catch (err) {
    console.error("⚠️  Voyage embedding failed:", err.message);
    return null;
  }
}

if (embCount === 0 && total > 0) {
  console.error(`✅ Vector store ready — ⚠️  no embeddings yet (${total} memories) — auto-backfilling silently…`);
  setImmediate(async () => {
    try {
      const pending = await store.listWithoutEmbeddings();
      let success = 0, failed = 0;
      for (const row of pending) {
        const embedding = await generateEmbedding(`${row.title}. ${row.content}`);
        if (embedding) { await store.setEmbedding(row.id, embedding); success++; }
        else failed++;
      }
      console.error(`✅ Auto-backfill complete: ${success} embedded${failed ? `, ${failed} failed` : ""}.`);
    } catch (err) {
      console.error(`⚠️  Auto-backfill error: ${err.message}`);
    }
  });
} else if (embCount === 0 && total === 0) {
  console.error(`✅ Vector store ready — no memories yet.`);
} else {
  console.error(`✅ Vector store ready — semantic search active (${embCount}/${total} memories embedded)`);
}

// ─── Path safety (shared across file tools) ───────────────────────────────────
const ALLOWED_PATHS = (process.env.APERIO_ALLOWED_PATHS || process.cwd())
  .split(",")
  .map(p => p.trim().replace(/^~/, process.cwd()));

function isPathAllowed(filePath) {
  const resolved = filePath.startsWith("~") ? filePath.replace("~", process.cwd()) : filePath;
  return ALLOWED_PATHS.some(a => resolved.startsWith(a + "/") || resolved === a);
}

// ─── Shared context passed to every tool module ───────────────────────────────
const ctx = { store, generateEmbedding, vectorEnabled: () => vectorEnabled, isPathAllowed, ALLOWED_PATHS };

// ─── MCP Server ───────────────────────────────────────────────────────────────
const server = new McpServer({ name: "aperio", version: "2.0.0" });

registerMemory(server, ctx);
registerFiles(server, ctx);
registerWeb(server, ctx);
registerImage(server, ctx);

// ─── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("🧠 Aperio MCP server v2.0 running");
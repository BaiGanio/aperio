import { McpServer }          from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv                   from "dotenv";
import { fileURLToPath }        from "url";
import { dirname, resolve }     from "path";
import { getStore }             from "../db/index.js";
import { generateEmbedding, initEmbeddings } from "./assets/embeddings.js";

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

export async function startServer(opts = {}) {
  const store = opts.store || await getStore();
  if (!store) {
    console.error("❌ MCP Error: Store failed to initialize.");
    if (process.env.NODE_ENV !== 'test') process.exit(1);
    throw new Error("Store failed");
  }

  // ─── Embeddings ───────────────────────────────────────────────────────────────
  // opts.vectorEnabled allows us to disable the backfill during tests
  let vectorEnabled = opts.vectorEnabled !== undefined ? opts.vectorEnabled : true;
  await initEmbeddings(store, (text, inputType) =>
    vectorEnabled ? generateEmbedding(text, inputType) : null
  );

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
  const transport = opts.transport || new StdioServerTransport();
  await server.connect(transport);  
  console.error("🧠 Aperio MCP server v2.0 running");
  
  // Return the server/transport so tests can close them
  return { server, transport };
}

// ─── EXECUTION GUARD ──────────────────────────────────────────────────────────
// Only run the server automatically if this file is the entry point
// and we are NOT in a test environment.
if (import.meta.url === `file://${process.argv[1]}` && process.env.NODE_ENV !== 'test') {
  startServer().catch(err => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });
}
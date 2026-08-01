import { McpServer }          from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv                   from "dotenv";
import { fileURLToPath }        from "url";
import { dirname, resolve }     from "path";
import { getStore }             from "../db/index.js";
import { generateEmbedding, initEmbeddings, checkEmbeddingProvider } from "../lib/helpers/embeddings.js";
import { createEmbeddingQueue } from "../lib/helpers/embedding-queue.js";
import packageJson from "../package.json" with { type: "json" };
import logger from "../lib/helpers/logger.js";

// Tool Registrations are dynamically imported inside startServer(), AFTER DB
// Settings are hydrated into process.env — several tool modules read
// process.env into module-level constants at import time (mcp/tools/shell.js's
// SHELL_ENABLED and MAX_OUTPUT_BYTES; mcp/tools/image.js's LLAMACPP_* config).
// A static import here would evaluate those modules — and freeze their
// constants from raw .env/defaults — before hydration ever runs, which for
// SHELL_ENABLED means a DB Settings toggle to disable host command execution
// would silently have no effect. See startServer() below.

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

/**
 * The Context (ctx) should only contain "Services"—stateful objects
 * that tools need to interact with the outside world (DB, AI, etc.)
 */
async function createContext(store, opts) {
  let vectorEnabled = opts.vectorEnabled !== undefined ? opts.vectorEnabled : true;

  // Detects a provider/model/dim change before the queue is built — without
  // this, an MCP-only deployment (no lib/server/hydrateRuntime.js in its boot
  // path) never notices a provider switch and writes new-space vectors next
  // to old-space ones. DB Settings are already hydrated into process.env by
  // startServer() before this runs, so EMBEDDING_PROVIDER/VOYAGE_MODEL/
  // EMBEDDING_DIMS here reflect the default `db` precedence (AGENTS.md), not
  // raw .env.
  await checkEmbeddingProvider(store);

  // Deliberately no background reindex here, unlike the HTTP server. MCP
  // processes are spawned per agent session, so several can be alive at once —
  // each running its own full reindex would multiply embedding calls by the
  // number of children with no benefit. Stale stores still serve full-text
  // results correctly; the long-lived server rebuilds them, or an operator
  // runs the CLI. Say so rather than degrading silently.
  try {
    const { listPendingStores } = await import("../lib/embeddings/reindex.js");
    const pending = await listPendingStores(store);
    if (pending.length) {
      console.error(
        `[aperio-mcp] ${pending.map(p => p.store_name).join(", ")} awaiting embedding reindex — ` +
        `serving full-text results for those stores. Run "npm run embeddings:reindex" or start the Aperio server to rebuild.`
      );
    }
  } catch { /* status reporting must never block MCP boot */ }

  // Initialize Embeddings engine
  await initEmbeddings(store, (text, inputType) =>
    vectorEnabled ? generateEmbedding(text, inputType) : null
  );

  const embeddingFn = (text, inputType) => vectorEnabled ? generateEmbedding(text, inputType) : null;
  const embeddingQueue = createEmbeddingQueue({ store, generateEmbedding: embeddingFn });

  return {
    store,
    generateEmbedding: embeddingFn,
    vectorEnabled: () => vectorEnabled,
    embeddingQueue,
    // PRIVACY-01: set by the agent when it spawns this process. When the active
    // provider is a cloud model this is false, and recall hides memories tagged
    // "local-only" so they never reach a third-party model.
    providerIsLocal: process.env.APERIO_PROVIDER_LOCAL !== "0",
  };
}

export async function startServer(opts = {}) {
  const store = opts.store || await getStore();
  if (!store) {
    logger.error("❌ MCP Error: Store failed to initialize.");
    if (process.env.NODE_ENV !== 'test') process.exit(1);
    throw new Error("Store failed");
  }

  // Resolve DB-backed Settings into process.env BEFORE importing any tool
  // module below — this must run first, not inside createContext, because
  // several tool modules read process.env into module-level constants at
  // static-import time (mcp/tools/shell.js's SHELL_ENABLED and
  // MAX_OUTPUT_BYTES; mcp/tools/image.js's LLAMACPP_* config), which freezes
  // before any function in this file would otherwise run. A standalone
  // `npm run mcp` deployment has no earlier hydration point — unlike the HTTP
  // server, which runs hydrateRuntime() in the parent process before spawning
  // this as a child with an already-resolved env (lib/agent/mcp-connect.js).
  // Without this, DB Settings disabling the shell tool would have no effect:
  // the tool stays live on whatever raw .env/default said at import time.
  const { applyConfigToEnv } = await import("../lib/config-resolver.js");
  await applyConfigToEnv(store);

  // 1. Create the service context
  const ctx = await createContext(store, opts);

  // 2. Initialize the MCP Server
  const server = new McpServer({ name: packageJson.name, version: packageJson.version });

  // 3. Register tools — dynamically imported only now, after the hydration
  // above, so their import-time env reads see the resolved configuration.
  // Note: registrees like 'registerFiles' import path validation
  // directly from '../lib/routes/paths.js' instead of getting it from ctx.
  const [
    { register: registerMemory },
    { register: registerSelfMemory },
    { register: registerSelfWiki },
    { register: registerFiles },
    { register: registerWeb },
    { register: registerImage },
    { register: registerShell },
    { register: registerWiki },
    { register: registerCodegraph },
    { register: registerDocgraph },
    { register: registerGithub },
    { register: registerData },
    { register: registerDatabase },
  ] = await Promise.all([
    import("./tools/memory.js"),
    import("./tools/self-memory.js"),
    import("./tools/self-wiki.js"),
    import("./tools/files.js"),
    import("./tools/web.js"),
    import("./tools/image.js"),
    import("./tools/shell.js"),
    import("./tools/wiki.js"),
    import("./tools/codegraph.js"),
    import("./tools/docgraph.js"),
    import("./tools/github.js"),
    import("./tools/data.js"),
    import("./tools/database.js"),
  ]);

  registerMemory(server, ctx);
  registerSelfMemory(server, ctx);
  registerSelfWiki(server, ctx);
  registerFiles(server, ctx);
  registerWeb(server, ctx);
  registerImage(server, ctx);
  registerShell(server);
  registerWiki(server, ctx);
  registerCodegraph(server, ctx);
  registerDocgraph(server, ctx);
  registerGithub(server, ctx);
  registerData(server, ctx);
  registerDatabase(server, ctx);

  // 4. Connect transport
  const transport = opts.transport || new StdioServerTransport();
  await server.connect(transport);  
  
  logger.info(`✨ ${packageJson.name} MCP server ${packageJson.version} running`);
  
  return { server, transport };
}

// Execution Guard
if (import.meta.url === `file://${process.argv[1]}` && process.env.NODE_ENV !== 'test') {
  startServer().catch(err => {
    // Write to stderr, NOT the logger: logger emits on stdout, which for an MCP
    // stdio server is the JSON-RPC channel — logging a fatal there both corrupts
    // the protocol and hides the cause from the parent. stderr is captured by the
    // parent transport and surfaced in createAgent's thrown error.
    process.stderr.write(`Failed to start MCP server: ${err?.stack || err?.message || err}\n`);
    process.exit(1);
  });
}
import { McpServer }          from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RequestSchema }        from "@modelcontextprotocol/sdk/types.js";
import { z }                    from "zod";
import dotenv                   from "dotenv";
import { timingSafeEqual }      from "node:crypto";
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
// dotenv writes its logs via console.log (stdout), and stdout is the JSON-RPC
// channel for a stdio MCP server — a stray line there is a protocol violation
// for strict clients. `quiet: true` covers the normal injection line, but
// DOTENV_CONFIG_DEBUG (from the parent env OR the .env file, re-read after
// populate) overrides quiet, so silence console.log for the duration of the
// config call — dotenv's only stdout writer. dotenv is synchronous and this
// block awaits nothing, so nothing else can log during the patch window.
const originalConsoleLog = console.log;
console.log = () => {};
try {
  dotenv.config({ path: resolve(__dirname, "../.env"), quiet: true });
} finally {
  console.log = originalConsoleLog;
}

/**
 * The Context (ctx) should only contain "Services"—stateful objects
 * that tools need to interact with the outside world (DB, AI, etc.)
 */
export async function createContext(store, opts) {
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
  // Separate queue for the self_memories table (issue F-R2-06) — it must not
  // share `embeddingQueue` above: that queue's gate and its retry write both
  // target the `memories` table (storeName + store.setEmbedding), so a
  // self-memory id run through it would gate on the wrong store's signature
  // and, on success, write nowhere a self-memory row could ever be found.
  const selfEmbeddingQueue = createEmbeddingQueue({
    store, generateEmbedding: embeddingFn, storeName: "self_memories",
    setEmbedding: (id, embedding) => store.setSelfEmbedding(id, embedding),
  });

  return {
    store,
    generateEmbedding: embeddingFn,
    vectorEnabled: () => vectorEnabled,
    embeddingQueue,
    selfEmbeddingQueue,
    // PRIVACY-01: set by the agent when it spawns this process. When the active
    // provider is a cloud model this is false, and recall hides memories tagged
    // "local-only" so they never reach a third-party model.
    //
    // Fails closed (F-R2-07): only an explicit "1" — set by
    // lib/agent/mcp-connect.js's connectMcp() when the orchestrator spawns
    // this process for a locally-detected provider, or by codex.js's explicit
    // "0" — counts as local. A standalone `npm run mcp` deployment (no
    // spawner to set the var at all, e.g. an external client like Claude
    // Desktop or Cursor talking to Aperio directly) leaves it unset and must
    // get the same self-memory wall a cloud provider gets, not the local one.
    providerIsLocal: process.env.APERIO_PROVIDER_LOCAL === "1",
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
    { register: registerExtraction },
    { clearSessionCacheHandler },
    { takeRedactionMap },
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
    import("./tools/extraction.js"),
    import("../lib/handlers/docgraph/docgraphHandlers.js"),
    import("../lib/handlers/memory/memoryHandlers.js"),
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
  registerExtraction(server, ctx);

  // Control channel for the main server process to invalidate docgraph's
  // session-scoped doc_batch dedup cache (lib/docgraph/retrieval.js's
  // sessionReadFacts) inside THIS child. Deliberately NOT registered as an
  // MCP tool: every tool a McpServer registers is discoverable via
  // tools/list() by any connected client — including a subscription
  // provider's own MCP client (Codex spawns and talks to its own separate
  // instance of this same mcp/index.js directly; runClaudeCodeLoop builds
  // its tool list from the full mcpTools catalog, not the per-turn profile-
  // filtered subset) — so a tool named e.g. "docgraph_clear_session_cache"
  // would be a real, model-callable tool regardless of what
  // lib/agent/tool-profiles.js says (llamacpp-multiturn-latency.md Step 3
  // review, round 5, P2). A custom JSON-RPC method on the low-level Server,
  // outside the Tools capability entirely, is invisible to tools/list() for
  // every client — see lib/agent/index.js's clearDocSessionCache(), the only
  // caller, which uses the SDK's generic Protocol#request() to reach it.
  const ClearDocSessionCacheRequestSchema = RequestSchema.extend({
    method: z.literal("aperio/clearDocSessionCache"),
    params: z.object({ sessionId: z.string() }).passthrough(),
  });
  server.server.setRequestHandler(ClearDocSessionCacheRequestSchema, async (request) => {
    await clearSessionCacheHandler(ctx, request.params);
    return { ok: true };
  });

  // Private redaction-map side channel for Privacy Shield's redact mode
  // (issue #531, review round 2). recallHandler hands the actual «LABEL_N» →
  // original PII map to takeRedactionMap()'s in-process store, keyed by a
  // one-time correlation id, and returns only that id in its public
  // CallToolResult — the same "custom method outside the Tools capability"
  // technique as aperio/clearDocSessionCache above. But invisibility from
  // tools/list() only hides discovery, it is not authorization: any peer
  // holding this exact stdio connection can still send the raw JSON-RPC
  // request by name. For a standalone deployment (`npm run mcp`, no
  // lib/agent/mcp-connect.js spawner in front) that peer IS the external
  // client itself — e.g. Claude Desktop or Cursor, exactly who redact mode
  // exists to keep this PII from — so without a further check that client
  // could redeem its own correlation id and read back every email/phone/
  // card/IBAN the visible text withheld (review round 6, P1).
  //
  // A shared secret closes that gap: lib/agent/mcp-connect.js's connectMcp()
  // mints one per spawn and passes it via APERIO_MCP_AUTH_TOKEN — known only
  // to that exact parent/child pair. Codex's separately-spawned child
  // (lib/agent/providers/codex.js) deliberately never receives it: Codex must
  // be able to WRITE a map via recall/self_recall but never redeem one
  // itself. A request whose token doesn't match this process's own copy —
  // including every request when no spawner set one at all — is treated
  // exactly like an unknown/expired id: an empty map, with nothing in the
  // response that would let a guessing attacker tell "wrong token" apart
  // from "wrong id".
  const MCP_AUTH_TOKEN = process.env.APERIO_MCP_AUTH_TOKEN || null;
  function isAuthorizedForRedactionMap(token) {
    if (!MCP_AUTH_TOKEN || typeof token !== "string") return false;
    const expected = Buffer.from(MCP_AUTH_TOKEN);
    const actual = Buffer.from(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  const TakeRedactionMapRequestSchema = RequestSchema.extend({
    method: z.literal("aperio/takeRedactionMap"),
    params: z.object({ correlationId: z.string(), token: z.string() }).passthrough(),
  });
  server.server.setRequestHandler(TakeRedactionMapRequestSchema, async (request) => {
    if (!isAuthorizedForRedactionMap(request.params.token)) {
      logger.warn("[mcp] rejected aperio/takeRedactionMap: missing or invalid auth token");
      return { redactionMap: {} };
    }
    return { redactionMap: takeRedactionMap(request.params.correlationId) ?? {} };
  });

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

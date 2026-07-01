import { McpServer }          from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv                   from "dotenv";
import { fileURLToPath }        from "url";
import { dirname, resolve }     from "path";
import { getStore }             from "../db/index.js";
import { generateEmbedding, initEmbeddings } from "../lib/helpers/embeddings.js";
import { createEmbeddingQueue } from "../lib/helpers/embedding-queue.js";
import packageJson from "../package.json" with { type: "json" };
import logger from "../lib/helpers/logger.js";

// Tool Registrations
import { register as registerMemory }  from "./tools/memory.js";
import { register as registerSelfMemory } from "./tools/self-memory.js";
import { register as registerFiles }   from "./tools/files.js";
import { register as registerWeb }     from "./tools/web.js";
import { register as registerImage }   from "./tools/image.js";
import { register as registerShell }   from "./tools/shell.js";
import { register as registerWiki }    from "./tools/wiki.js";
import { register as registerCodegraph } from "./tools/codegraph.js";
import { register as registerDocgraph }  from "./tools/docgraph.js";
import { register as registerGithub }    from "./tools/github.js";
import { register as registerData }     from "./tools/data.js";
import { register as registerDatabase } from "./tools/database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

/**
 * The Context (ctx) should only contain "Services"—stateful objects 
 * that tools need to interact with the outside world (DB, AI, etc.)
 */
async function createContext(store, opts) {
  let vectorEnabled = opts.vectorEnabled !== undefined ? opts.vectorEnabled : true;

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

  // 1. Create the service context
  const ctx = await createContext(store, opts);

  // 2. Initialize the MCP Server
  const server = new McpServer({ name: packageJson.name, version: packageJson.version });

  // 3. Register tools
  // Note: registrees like 'registerFiles' will now import 'isPathAllowed' 
  // directly from '../lib/utils/paths.js' instead of getting it from ctx.
  registerMemory(server, ctx);
  registerSelfMemory(server, ctx);
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
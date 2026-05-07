import { McpServer }          from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv                   from "dotenv";
import { fileURLToPath }        from "url";
import { dirname, resolve }     from "path";
import { getStore }             from "../db/index.js";
import { generateEmbedding, initEmbeddings } from "../lib/helpers/embeddings.js";
import packageJson from "../package.json" with { type: "json" };
import logger from "../lib/helpers/logger.js";

// Tool Registrations
import { register as registerMemory }  from "./tools/memory.js";
import { register as registerFiles }   from "./tools/files.js";
import { register as registerWeb }     from "./tools/web.js";
import { register as registerImage }   from "./tools/image.js";

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

  return {
    store,
    generateEmbedding: (text, inputType) => vectorEnabled ? generateEmbedding(text, inputType) : null,
    vectorEnabled: () => vectorEnabled,
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
  registerFiles(server, ctx);
  registerWeb(server, ctx);
  registerImage(server, ctx);

  // 4. Connect transport
  const transport = opts.transport || new StdioServerTransport();
  await server.connect(transport);  
  
  logger.info(`✨ ${packageJson.name} MCP server ${packageJson.version} running`);
  
  return { server, transport };
}

// Execution Guard
if (import.meta.url === `file://${process.argv[1]}` && process.env.NODE_ENV !== 'test') {
  startServer().catch(err => {
    logger.error("Failed to start MCP server:", err);
    process.exit(1);
  });
}
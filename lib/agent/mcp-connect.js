// MCP client startup + the per-provider tool catalogs derived from it.
//
// Extracted from lib/agent/index.js. This is one-shot setup: it runs once
// during createAgent(), returns a bag of immutable lookups, and shares no
// mutable state with the rest of the factory afterwards — the only live handle
// is `mcp` itself, which callTool() uses.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "path";
import { isLocalProvider } from "../providers/index.js";
import { zodToJsonSchema } from "../providers/schema.js";

/**
 * Connect the stdio MCP client and list its tools.
 *
 * Captures the MCP child's stderr so a startup crash surfaces its real cause
 * instead of a bare "Connection closed" when the pipe drops (e.g. the DB
 * fails to open/decrypt). The child logs its fatal error there before exiting.
 */
async function connectMcp({ root, clientName, version, provider }) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--no-warnings=ExperimentalWarning", resolve(root, "mcp/index.js")],
    env: {
      ...process.env,
      APERIO_PROC_ROLE: "mcp",
      APERIO_PROVIDER_LOCAL: isLocalProvider(provider.name) ? "1" : "0",
    },
    stderr: "pipe",
  });
  const mcp = new Client({ name: clientName, version });
  let mcpStderr = "";
  transport.stderr?.on("data", chunk => { mcpStderr += chunk.toString(); });
  try {
    await mcp.connect(transport);
    const { tools } = await mcp.listTools();
    return { mcp, tools };
  } catch (err) {
    // The child's fatal log may still be draining when its stdout pipe drops
    // and rejects connect — wait briefly for stderr to flush before reading it.
    await new Promise(res => {
      if (!transport.stderr) return res();
      transport.stderr.on("end", res);
      transport.stderr.on("close", res);
      setTimeout(res, 300);
    });
    const detail = mcpStderr.trim();
    if (detail) err.message += `\n  ↳ MCP server output:\n${detail.split("\n").map(l => "    " + l).join("\n")}`;
    throw err;
  }
}

/**
 * Register main-process host tools alongside the MCP ones. Host tools run
 * in-process (no MCP round trip) but present an identical schema to the model.
 */
function registerHostTools(mcpTools, hostTools) {
  const hostToolHandlers = new Map();
  const hostToolSchemas = [];
  for (const tool of hostTools) {
    if (!tool?.name || typeof tool.handler !== "function") {
      throw new Error("Host tools require a name and handler function.");
    }
    if (hostToolHandlers.has(tool.name) || mcpTools.some((candidate) => candidate.name === tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    hostToolHandlers.set(tool.name, tool.handler);
    hostToolSchemas.push({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    });
  }
  return { hostToolHandlers, hostToolSchemas };
}

/**
 * Connect MCP, merge in host tools, apply the AgentSpec allowlist, and
 * precompute the per-provider tool shapes (Anthropic / OpenAI / Gemini) plus
 * the normalized JSON schemas used to instrument tool-call arguments.
 */
export async function createToolCatalog({ root, clientName, version, provider, hostTools, toolAllowlist }) {
  const { mcp, tools } = await connectMcp({ root, clientName, version, provider });
  const { hostToolHandlers, hostToolSchemas } = registerHostTools(tools, hostTools);

  const allMcpTools = [...tools, ...hostToolSchemas];
  const allowedToolNames = Array.isArray(toolAllowlist) ? new Set(toolAllowlist) : null;
  const mcpTools = allowedToolNames
    ? allMcpTools.filter(tool => allowedToolNames.has(tool.name))
    : allMcpTools;

  // Normalized { type, properties, required } per tool, used to instrument
  // tool-call arguments against the declared schema (see lib/tools/schemaCheck.js).
  const toolSchemas = new Map(mcpTools.map(t => [t.name, zodToJsonSchema(t.inputSchema)]));
  const anthropicToolsAll = mcpTools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const openaiToolsAll = mcpTools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: zodToJsonSchema(t.inputSchema) } }));
  const geminiDeclsAll = mcpTools.map(t => ({ name: t.name, description: t.description, parameters: zodToJsonSchema(t.inputSchema) }));

  return {
    mcp,
    mcpTools,
    hostToolHandlers,
    toolSchemas,
    allowedToolNames,
    anthropicByName: new Map(anthropicToolsAll.map(t => [t.name, t])),
    openaiByName: new Map(openaiToolsAll.map(t => [t.function.name, t])),
    geminiByName: new Map(geminiDeclsAll.map(d => [d.name, d])),
  };
}

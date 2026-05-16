import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

class MCPConnection {
  constructor() {
    this.client = null;
  }

  async connect() {
    const transport = this._createTransport();
    this.client = new Client({ name: "mcp-evaluator", version: "1.0.0" });
    await this.client.connect(transport);
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  async listTools() {
    const { tools } = await this.client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  async callTool(name, args) {
    const result = await this.client.callTool({ name, arguments: args });
    return result.content;
  }
}

class MCPConnectionStdio extends MCPConnection {
  constructor(command, args = [], env = {}) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
  }

  _createTransport() {
    return new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: { ...process.env, ...this.env },
    });
  }
}

class MCPConnectionSSE extends MCPConnection {
  constructor(url, headers = {}) {
    super();
    this.url = url;
    this.headers = headers;
  }

  _createTransport() {
    return new SSEClientTransport(new URL(this.url), {
      requestInit: { headers: this.headers },
    });
  }
}

class MCPConnectionHTTP extends MCPConnection {
  constructor(url, headers = {}) {
    super();
    this.url = url;
    this.headers = headers;
  }

  _createTransport() {
    return new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: this.headers },
    });
  }
}

export function createConnection({ transport, command, args, env, url, headers }) {
  const t = (transport || "stdio").toLowerCase();

  if (t === "stdio") {
    if (!command) throw new Error("--command is required for stdio transport");
    return new MCPConnectionStdio(command, args, env);
  }
  if (t === "sse") {
    if (!url) throw new Error("--url is required for sse transport");
    return new MCPConnectionSSE(url, headers);
  }
  if (t === "http" || t === "streamable-http" || t === "streamable_http") {
    if (!url) throw new Error("--url is required for http transport");
    return new MCPConnectionHTTP(url, headers);
  }

  throw new Error(`Unsupported transport: ${transport}. Use stdio, sse, or http`);
}

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../../mcp/index.js";

describe("MCP Server CI Check", () => {
  test("initializes without blocking", async () => {
    const mockTransport = {
      start: async () => {},
      close: async () => {},
      onclose: () => {},
      onerror: () => {},
      onmessage: () => {},
      send: async () => {},
    };

    // Provide the methods initEmbeddings actually calls
    const mockStore = { 
      counts: async () => ({ total: 0, embedded: 0 }), // Fixes the TypeError
      table: async () => ({ 
        add: async () => {},
        countRows: async () => 0
      }),
      search: async () => [] 
    };

    const { server } = await startServer({ 
      transport: mockTransport,
      store: mockStore,
      vectorEnabled: false 
    });
    
    assert.ok(server);
  });
});

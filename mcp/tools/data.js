// mcp/tools/data.js
// Data portability tools — export and import the Aperio database.
import { z } from 'zod';
import { exportDataHandler, importDataHandler } from '../../lib/handlers/data/dataHandlers.js';

const createBoundHandlers = (ctx) => ({
  exportAll: (args) => exportDataHandler(ctx, args),
  importAll: (args) => importDataHandler(ctx, args),
});

const TOOLS = [
  {
    name: 'export_data',
    description:
      'Export all memories and wiki articles to a portable JSON file. ' +
      'Use this to back up your data or migrate to another machine. ' +
      'Embeddings are NOT exported — run backfill_embeddings after import if you need semantic search. ' +
      'The exported file is written to the specified path (defaults to ~/aperio-export-<timestamp>.json).',
    schema: {
      output_path: z.string().optional()
        .describe('Absolute path for the export file. Defaults to ~/aperio-export-<timestamp>.json.'),
    },
    getHandler: (h) => h.exportAll,
  },
  {
    name: 'import_data',
    description:
      'Import memories and wiki articles from a previously-exported JSON file. ' +
      'Idempotent: memories are matched by ID and wiki articles by slug, so running twice on the same file ' +
      'does not create duplicates. Embeddings are queued for backfill — run backfill_embeddings afterward ' +
      'if you need semantic search on the imported data.',
    schema: {
      input_path: z.string()
        .describe('Absolute path to the .json export file to import from.'),
    },
    getHandler: (h) => h.importAll,
  },
];

function buildInputSchema(tool) {
  return z.object(tool.schema);
}

export function register(server, ctx) {
  const handlers = createBoundHandlers(ctx);
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: buildInputSchema(tool) },
      tool.getHandler(handlers)
    );
  }
}

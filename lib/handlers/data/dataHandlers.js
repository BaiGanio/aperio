// lib/handlers/data/dataHandlers.js
// Handlers for data export/import MCP tools.
//
// export_data  — dumps all memories + wiki articles to a portable JSON file.
// import_data  — restores from that file, deduplicating by memory ID / wiki slug.
//
// Embeddings are NOT exported (they're large and backend-specific). The import
// handler should be followed by a backfill_embeddings call if semantic search
// is needed for the imported data.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import logger from '../../helpers/logger.js';

const EXPORT_VERSION = 1;

function defaultExportPath() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(homedir(), `aperio-export-${ts}.json`);
}

// ── Export ────────────────────────────────────────────────────────────────────

export async function exportDataHandler(ctx, { output_path }) {
  const { store } = ctx;
  const outPath = output_path || defaultExportPath();

  const data = await store.exportAll();

  const payload = {
    aperio_export: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    counts: {
      memories: data.memories.length,
      wiki_articles: data.wiki_articles.length,
    },
    memories: data.memories,
    wiki_articles: data.wiki_articles,
  };

  writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  const msg = [
    `✅ Exported ${payload.counts.memories} memories`,
    `and ${payload.counts.wiki_articles} wiki articles`,
    `to ${outPath}`,
    `(${(Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(1)} KB)`,
  ].join(' ');

  logger.info(`[data] ${msg}`);
  return { content: [{ type: 'text', text: msg }] };
}

// ── Import ────────────────────────────────────────────────────────────────────

export async function importDataHandler(ctx, { input_path }) {
  const { store, embeddingQueue } = ctx;

  if (!existsSync(input_path)) {
    return { content: [{ type: 'text', text: `❌ File not found: ${input_path}` }] };
  }

  let payload;
  try {
    payload = JSON.parse(readFileSync(input_path, 'utf8'));
  } catch (err) {
    return { content: [{ type: 'text', text: `❌ Could not parse ${input_path}: ${err.message}` }] };
  }

  if (!payload.aperio_export || !payload.memories || !payload.wiki_articles) {
    return { content: [{ type: 'text', text: `❌ ${input_path} is not a valid Aperio export file (missing aperio_export version or data arrays).` }] };
  }

  const result = await store.importAll({
    memories: payload.memories,
    wiki_articles: payload.wiki_articles,
  });

  // Queue imported memories for embedding backfill so semantic search works.
  let queued = 0;
  if (embeddingQueue && result.imported.memories > 0) {
    for (const m of payload.memories) {
      // Only enqueue if this memory was actually imported (not skipped).
      // We don't have per-memory skip tracking here, so we queue all;
      // the backfill worker handles duplicates gracefully.
      if (m.id && m.title && m.content) {
        embeddingQueue.enqueue(m.id, `${m.title}. ${m.content}`);
        queued++;
      }
    }
  }

  const msg = [
    `✅ Import complete:`,
    `${result.imported.memories} memories imported, ${result.skipped.memories} skipped`,
    `· ${result.imported.wiki} wiki articles imported, ${result.skipped.wiki} skipped`,
    queued > 0 ? `· ${queued} embeddings queued for backfill` : '',
  ].filter(Boolean).join('\n');

  logger.info(`[data] ${msg.replace(/\n/g, ' | ')}`);
  return { content: [{ type: 'text', text: msg }] };
}

// src/tools/memory-tools.js - the remember and recall tools (spec S2.7 rev 3 §2.3).
//
// The model decides when to call them (developer decision 2026-11-11). Code
// only runs a call: it checks secrets, stops duplicates, stores the vector with
// the row (the v1 null-vector bug, L-C13), and searches.
// Each tool is { name, description, parameters, run(args, ctx) }. The
// definitions are frozen, so the tool bytes on the wire never drift (L-M04).
// ctx = { store, embedder, config, log }. No module state (AP6).

import { MEMORY_TYPES } from '../store/memory-store.js';
import { hasSecret } from './secret-scan.js';

const TITLE_WORDS = 8;
const MAX_RECALL = 10;

const text = (x) => (typeof x === 'string' ? x.trim() : '');
const titleOf = (content) => content.split(/\s+/).filter(Boolean).slice(0, TITLE_WORDS).join(' ');

/** Embed one text, or null with a warn: a missing vector is filled by the S2.4 reindex. */
async function vectorOf(content, { embedder, log }) {
  if (!embedder) {
    log.warn('[remember] no embedder: saved without a vector (the reindex fills it later)');
    return null;
  }
  try {
    return await embedder.embed(content);
  } catch (err) {
    log.warn(`[remember] the embedder failed, saved without a vector: ${err.message}`);
    return null;
  }
}

/** Store errors are thrown: the tool loop turns them into ok: false (AP5). */
async function remember(args, ctx) {
  const content = text(args?.content);
  if (!content) return { ok: false, error: 'content: give the fact to save, in one plain sentence.' };
  if (hasSecret(content)) return { ok: false, error: 'Not saved: this looks like a secret (a key, token or password). Secrets are never stored.' };

  const { store, embedder, config } = ctx;
  const vector = await vectorOf(content, ctx);
  if (vector) {
    const [top] = await store.search({ query: content, queryEmbedding: vector, mode: 'semantic', limit: 1, sig: embedder.sig });
    if (top && top.score * 100 >= config.REMEMBER_DUP_SCORE) {
      return { ok: true, duplicate: true, id: top.id, message: `Already saved as "${top.title}".` };
    }
  }
  const type = MEMORY_TYPES.includes(args?.type) ? args.type : 'fact';
  const title = text(args?.title).slice(0, 200) || titleOf(content);
  const row = await store.insert({ type, title, content, source: 'tool' }, vector, vector ? embedder.sig : undefined);
  return { ok: true, id: row.id, message: 'Saved.' };
}

async function recall(args, ctx) {
  const query = text(args?.query);
  if (!query) return { ok: false, error: 'query: say what to search for.' };
  const { store, embedder, config, log } = ctx;
  const limit = Math.min(Math.max(Number.parseInt(args?.limit ?? config.RECALL_TOP_K, 10) || config.RECALL_TOP_K, 1), MAX_RECALL);
  let queryEmbedding = null;
  if (embedder) {
    try {
      queryEmbedding = await embedder.embedQuery(query);
    } catch (err) {
      log.warn(`[recall] the embedder failed, searching by words only: ${err.message}`);
    }
  }
  const hits = await store.search({ query, queryEmbedding, mode: 'auto', limit, sig: embedder?.sig });
  if (!hits.length) return { ok: true, memories: [], message: 'No memories match.' };
  return { ok: true, memories: hits.map((h) => ({ title: h.title, content: h.content, date: String(h.createdAt).slice(0, 10) })) };
}

const freeze = (tool) => Object.freeze({ ...tool, parameters: deepFreeze(tool.parameters) });
function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

export const rememberTool = freeze({
  name: 'remember',
  description: 'Save one fact for later sessions. Call it when the user asks you to remember something, or tells you a fact worth keeping. One fact per call, in plain words. Never save secrets.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The fact, as one plain sentence that makes sense on its own.' },
      title: { type: 'string', description: 'A short title (optional).' },
      type: { type: 'string', enum: [...MEMORY_TYPES], description: 'The kind of memory (optional, default fact).' },
    },
    required: ['content'],
  },
  run: remember,
});

export const recallTool = freeze({
  name: 'recall',
  description: 'Search your saved memories. Call it before you answer when the question may depend on something the user told you before.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for, in a few words.' },
      limit: { type: 'integer', description: `How many memories to return (optional, at most ${MAX_RECALL}).` },
    },
    required: ['query'],
  },
  run: recall,
});

export const MEMORY_TOOLS = Object.freeze([rememberTool, recallTool]);

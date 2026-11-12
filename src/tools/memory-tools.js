// src/tools/memory-tools.js - the 5 memory tools: remember, recall (spec S2.7
// rev 3 §2.3), update, forget, list (spec S2.8 §2).
//
// The model decides when to call them (developer decision 2026-11-11). Code
// only runs a call: it checks secrets, stops duplicates, stores the vector with
// the row (the v1 null-vector bug, L-C13), and searches.
// Each tool is { name, description, parameters, run(args, ctx) }. The
// definitions are frozen, so the tool bytes on the wire never drift (L-M04).
// ctx = { store, embedder, config, log } (makeToolCtx in tool-loop.js). No module state (AP6).

import { MEMORY_TYPES } from '../store/memory-store.js';
import { hasSecret } from './secret-scan.js';

const TITLE_WORDS = 8;
const MAX_RECALL = 10;
const MAX_LIST = 50;
const LIST_ORDERS = Object.freeze(['importance', 'recent']);
const NO_ID = 'Call recall or list to find the id.';

const text = (x) => (typeof x === 'string' ? x.trim() : '');
const titleOf = (content) => content.split(/\s+/).filter(Boolean).slice(0, TITLE_WORDS).join(' ');

const dateOf = (createdAt) => String(createdAt).slice(0, 10);
const oneOf = (field, allowed) => ({ ok: false, error: `${field}: must be one of ${allowed.join(', ')}.` });
const SECRET = 'Not saved: this looks like a secret (a key, token or password). Secrets are never stored.';

/** Embed one text, or null with a warn: a missing vector is filled by the S2.4 reindex. */
async function vectorOf(content, { embedder, log }, tool = 'remember') {
  if (!embedder) {
    log.warn(`[${tool}] no embedder: saved without a vector (the reindex fills it later)`);
    return null;
  }
  try {
    return await embedder.embed(content);
  } catch (err) {
    log.warn(`[${tool}] the embedder failed, saved without a vector: ${err.message}`);
    return null;
  }
}

/** The row for a model-given id, or an ok: false result that tells the model what to do. */
async function rowFor(args, store) {
  const id = text(args?.id);
  if (!id) return { error: { ok: false, error: `id: give the memory id. ${NO_ID}` } };
  const row = await store.getById(id);
  if (!row) return { error: { ok: false, error: `No memory with id ${id}. ${NO_ID}` } };
  return { row };
}

/** Store errors are thrown: the tool loop turns them into ok: false (AP5). */
async function remember(args, ctx) {
  const content = text(args?.content);
  if (!content) return { ok: false, error: 'content: give the fact to save, in one plain sentence.' };
  if (hasSecret(content)) return { ok: false, error: SECRET };

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
  return { ok: true, memories: hits.map((h) => ({ id: h.id, title: h.title, content: h.content, date: dateOf(h.createdAt) })) };
}

/** The id stays the same; the store keeps the old text in memory_history. */
async function update(args, ctx) {
  const { row, error } = await rowFor(args, ctx.store);
  if (error) return error;
  const patch = {};
  for (const field of ['content', 'title']) {
    if (args[field] === undefined) continue;
    const value = text(args[field]);
    if (!value) return { ok: false, error: `${field}: give the new text, or leave the field out.` };
    patch[field] = field === 'title' ? value.slice(0, 200) : value;
  }
  if (args.type !== undefined) {
    if (!MEMORY_TYPES.includes(args.type)) return oneOf('type', MEMORY_TYPES);
    patch.type = args.type;
  }
  if (!Object.keys(patch).length) return { ok: false, error: 'Give at least one of: content, title, type.' };
  if ((patch.content && hasSecret(patch.content)) || (patch.title && hasSecret(patch.title))) return { ok: false, error: SECRET };

  // The vector is of the content. Any text change makes the store drop the old
  // vector, so pass a fresh one (null when the embedder fails: the reindex fills it).
  let vector;
  if (patch.content !== undefined || patch.title !== undefined) {
    vector = await vectorOf(patch.content ?? row.content, ctx, 'update');
  }
  await ctx.store.update(row.id, patch, vector ?? undefined, vector ? ctx.embedder.sig : undefined);
  return { ok: true, id: row.id, message: 'Updated.' };
}

/** Deletes the row, its vector and its history in one transaction (L-C13). */
async function forget(args, ctx) {
  const { row, error } = await rowFor(args, ctx.store);
  if (error) return error;
  const title = await ctx.store.delete(row.id);
  return { ok: true, id: row.id, message: `Forgotten: "${title}".` };
}

async function list(args, ctx) {
  const type = args?.type;
  const order = args?.order ?? 'importance';
  if (type !== undefined && !MEMORY_TYPES.includes(type)) return oneOf('type', MEMORY_TYPES);
  if (!LIST_ORDERS.includes(order)) return oneOf('order', LIST_ORDERS);
  const limit = Math.min(Math.max(Number.parseInt(args?.limit ?? ctx.config.LIST_LIMIT, 10) || ctx.config.LIST_LIMIT, 1), MAX_LIST);
  const rows = await ctx.store.list({ type, order, limit: limit + 1 });
  const more = rows.length > limit;
  const memories = rows.slice(0, limit).map((r) => ({ id: r.id, title: r.title, type: r.type, date: dateOf(r.createdAt) }));
  if (!memories.length) return { ok: true, memories, more, message: 'No memories saved.' };
  return { ok: true, memories, more };
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

export const updateTool = freeze({
  name: 'update',
  description: 'Change a saved memory. Call it when the user corrects or changes something you saved. Get the id from recall or list first.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The memory id, from recall or list.' },
      content: { type: 'string', description: 'The new fact, as one plain sentence (optional).' },
      title: { type: 'string', description: 'A new short title (optional).' },
      type: { type: 'string', enum: [...MEMORY_TYPES], description: 'A new kind of memory (optional).' },
    },
    required: ['id'],
  },
  run: update,
});

export const forgetTool = freeze({
  name: 'forget',
  description: 'Delete a saved memory for good. Call it only when the user asks you to forget, delete or remove a memory, and then always call it: saying "done" without the call deletes nothing. Get the id from recall or list first.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The memory id, from recall or list.' },
    },
    required: ['id'],
  },
  run: forget,
});

export const listTool = freeze({
  name: 'list',
  description: 'List your saved memories: id, title, type and date, no content. Call it when the user asks what you have saved.',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [...MEMORY_TYPES], description: 'Only this kind of memory (optional).' },
      order: { type: 'string', enum: [...LIST_ORDERS], description: 'importance (default) or recent (newest first).' },
      limit: { type: 'integer', description: `How many to return (optional, at most ${MAX_LIST}).` },
    },
    required: [],
  },
  run: list,
});

export const MEMORY_TOOLS = Object.freeze([rememberTool, recallTool, updateTool, forgetTool, listTool]);

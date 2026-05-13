// db/lancedb.js
// Zero-config embedded backend — no Docker, no server.
// Data lives in LANCEDB_PATH (default: ./.lancedb)

import { connect }          from '@lancedb/lancedb';
import { Schema, Field, Utf8, Float32, Float64, Int32, List, FixedSizeList } from 'apache-arrow';
import logger               from '../lib/helpers/logger.js';
import { v4 as uuidv4 }     from 'uuid';
import path                 from 'path';
import fs                   from 'fs';
import { randomUUID }       from 'node:crypto'; // Built-in Node.js UUID generator
import { deserialiseRow }   from './types.js';

const RELATIVE_PATH = process.env.LANCEDB_PATH ?? './.lancedb';
const DB_PATH = path.resolve(process.cwd(), RELATIVE_PATH);
const TABLE   = 'memories';
const DIMS    = parseInt(process.env.EMBEDDING_DIMS ?? '1024', 10);

// Explicit schema so nullable fields like expires_at don't cause type-inference failures.
const makeSchema = (dims) => new Schema([
  new Field('id',         new Utf8(),                        false),
  new Field('type',       new Utf8(),                        false),
  new Field('title',      new Utf8(),                        false),
  new Field('content',    new Utf8(),                        false),
  new Field('tags',       new Utf8(),                        false),
  new Field('importance', new Int32(),                       false),
  new Field('created_at', new Utf8(),                        false),
  new Field('updated_at', new Utf8(),                        false),
  new Field('expires_at', new Utf8(),                        true),
  new Field('source',     new Utf8(),                        false),
  new Field('valid_from', new Utf8(),                        false),
  new Field('valid_until',new Utf8(),                        true),
  new Field('confidence', new Float64(),                     false),
  new Field('vector',     new FixedSizeList(dims, new Field('item', new Float32(), false)), false),
]);


function toRow(id, input, embedding, createdAt, validFrom) {
  const now = new Date();
  return {
    id,
    type:        input.type,
    title:       input.title,
    content:     input.content,
    tags:        JSON.stringify(input.tags ?? []),
    importance:  input.importance ?? 3,
    created_at:  (createdAt ?? now).toISOString(),
    updated_at:  now.toISOString(),
    expires_at:  input.expires_at ? new Date(input.expires_at).toISOString() : null,
    source:      input.source ?? 'manual',
    valid_from:  (validFrom ?? now).toISOString(),
    valid_until: null,
    confidence:  input.confidence ?? 1.0,
    vector:      embedding ?? new Array(DIMS).fill(0),
  };
}

function notExpired(row) {
  return !row.expires_at || new Date(row.expires_at) > new Date();
}

function isCurrent(row, asOf) {
  if (asOf) {
    const t = new Date(asOf);
    return new Date(row.valid_from) <= t && (!row.valid_until || new Date(row.valid_until) > t);
  }
  return !row.valid_until;
}

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

// Rank docs by BM25 against a free-text query. Returns docs sorted by score (desc),
// zeros excluded. k1=1.5, b=0.75 are standard Okapi BM25 defaults.
function bm25Rank(query, docs, { k1 = 1.5, b = 0.75 } = {}) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length || !docs.length) return [];

  const getText = r => `${r.title} ${r.content}`.toLowerCase();
  const texts   = docs.map(getText);
  const avgDl   = texts.reduce((s, t) => s + t.length, 0) / texts.length;
  const N       = docs.length;

  const idf = Object.fromEntries(terms.map(term => {
    const df = texts.filter(t => t.includes(term)).length;
    return [term, Math.log((N - df + 0.5) / (df + 0.5) + 1)];
  }));

  const re = term => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');

  return docs
    .map((doc, i) => {
      const text = texts[i];
      const dl   = text.length;
      let score  = 0;
      for (const term of terms) {
        const tf = (text.match(re(term)) ?? []).length;
        if (tf === 0) continue;
        score += idf[term] * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgDl));
      }
      return { doc, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, bScore) => bScore.score - a.score)
    .map(({ doc }) => doc);
}

// Reciprocal Rank Fusion over two pre-ranked arrays of rows.
// k=60 is the standard constant that dampens the impact of high ranks.
function rrfMerge(vectorRanked, textRanked, limit, k = 60) {
  const scores = new Map();
  const byId   = new Map();

  vectorRanked.forEach((row, i) => {
    scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (k + i + 1));
    byId.set(row.id, row);
  });
  textRanked.forEach((row, i) => {
    scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (k + i + 1));
    byId.set(row.id, row);
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, rrf_score]) => ({ ...deserialiseRow(byId.get(id)), similarity: rrf_score }));
}

async function assertDims(table, expected) {
  const schema = await table.schema();
  const vectorField = schema.fields.find(f => f.name === 'vector');
  if (!vectorField) return;
  const actual = vectorField.type.listSize;
  if (actual !== expected) {
    throw new Error(
      `LanceDB vector dimension mismatch: table has ${actual}D but EMBEDDING_DIMS=${expected}. ` +
      `Either set EMBEDDING_DIMS=${actual} or delete the .lancedb directory to start fresh.`
    );
  }
}

export class LanceDBStore {
  constructor() {
    this.table  = null;
    this.db     = null;
    this.cache  = []; // in-memory cache for filter/dedup ops
  }

  static async init() {
    // Force create the parent directory if it doesn't exist
    if (!fs.existsSync(DB_PATH)) {
        fs.mkdirSync(DB_PATH, { recursive: true });
    }
    const store = new LanceDBStore();
    const db = await connect(DB_PATH);
    store.db = db;
    const existing = await db.tableNames();

    if (existing.includes(TABLE)) {
      store.table = await db.openTable(TABLE);
      await assertDims(store.table, DIMS);
      // Migrate to temporal schema if needed (adds valid_from/valid_until/confidence)
      const schema = await store.table.schema();
      if (!schema.fields.some(f => f.name === 'valid_from')) {
        await store._migrateToTemporal();
      }
    } else {
      const seedData = [
        {
          type: 'preference', 
          title: 'Code style preference', 
          content: 'I prefer clean, readable code over clever one-liners. Comments should explain WHY, not WHAT.', 
          tags: ['coding', 'style'], 
          importance: 4
        },
        {
          type: 'project', 
          title: 'Aperio', 
          content: 'A personal memory layer for AI tools. Built with Postgres + MCP. Currently in early development.', 
          tags: ['mcp', 'lancedb', 'ai', 'personal', 'docker'], 
          importance: 4
        }
      ];
      
      // Map to your internal row format using actual UUIDs
      const rows = seedData.map(metadata => 
        toRow(
          randomUUID(), // Generate a unique ID for every seed entry
          { ...metadata, source: 'system' }, 
          new Array(DIMS).fill(0)
        )
      );

      logger.info(`✨ Creating table: ${TABLE}`);
      store.table = await db.createTable(TABLE, rows, { schema: makeSchema(DIMS) });
    }
    // ALWAYS open the table using openTable (don't rely on the createTable return)
    try {
        store.table = await db.openTable(TABLE);
    } catch (err) {
        logger.error("[aperio:db] Table created but failed to open. Retrying...");
    }

    await store.refreshCache();
    return store;
  }

  async refreshCache() {
    const results = await this.table
      .query()
      .limit(10_000)
      .toArray();
    this.cache = results
      .filter(r => r.id !== '__init__')
      .map(r => ({
        ...r,
        // LanceDB returns FloatVector<Float> which lacks .every()/.some().
        // Normalize to Float32Array so downstream embedding checks work correctly.
        vector: r.vector?.toArray?.() ?? r.vector ?? new Array(DIMS).fill(0),
      }));
  }

  async _migrateToTemporal() {
    logger.info('[lancedb] Migrating to temporal schema (adding valid_from / valid_until / confidence)…');
    const raw = await this.table.query().limit(100_000).toArray();
    const migrated = raw.map(r => ({
      ...r,
      vector:      r.vector?.toArray?.() ?? r.vector ?? new Array(DIMS).fill(0),
      valid_from:  r.created_at ?? new Date().toISOString(),
      valid_until: null,
      confidence:  1.0,
    }));
    await this.db.dropTable(TABLE);
    this.table = await this.db.createTable(TABLE, migrated);
    this.table = await this.db.openTable(TABLE);
    logger.info(`[lancedb] Migration complete: ${migrated.length} row(s) updated`);
  }

  async counts() {
    await this.refreshCache();
    const active = this.cache.filter(r => !r.valid_until);
    const withEmbedding = active.filter(r => {
      if (!r.vector) return false;
      if (typeof r.vector.every !== 'function') return false;
      return r.vector.some(v => v !== 0);
    }).length;
    return { total: active.length, embedded: withEmbedding };
  }

  async insert(input, embedding) {
    const id  = uuidv4();
    const row = toRow(id, input, embedding);
    await this.table.add([row]);
    this.cache.push(row);
    return deserialiseRow(row);
  }

  async bulkInsert(inputs) {
    if (!inputs.length) return [];
    const rows = inputs.map(input => toRow(uuidv4(), input, null));
    await this.table.add(rows);
    this.cache.push(...rows);
    return rows.map(deserialiseRow);
  }

  async getById(id) {
    const row = this.cache.find(r => r.id === id);
    return row ? deserialiseRow(row) : null;
  }

  async update(id, input, embedding) {
    const existing = this.cache.find(r => r.id === id);
    if (!existing) throw new Error(`Memory ${id} not found`);
    if (existing.valid_until) throw new Error(`Memory ${id} has been superseded`);

    const merged = {
      type:       input.type       ?? existing.type,
      title:      input.title      ?? existing.title,
      content:    input.content    ?? existing.content,
      tags:       input.tags       ?? JSON.parse(existing.tags || '[]'),
      importance: input.importance ?? existing.importance,
      expires_at: input.expires_at ?? (existing.expires_at ? new Date(existing.expires_at) : undefined),
      source:     existing.source,
      confidence: input.confidence ?? (existing.confidence ?? 1.0),
    };

    const now = new Date().toISOString();

    // Tombstone the existing row
    const tombstoned = { ...existing, valid_until: now, updated_at: now };
    await this.table.delete(`id = '${id}'`);
    await this.table.add([tombstoned]);
    this.cache = this.cache.map(r => r.id === id ? tombstoned : r);

    // Insert new version
    const newVec = embedding !== undefined ? embedding : existing.vector;
    const newId  = uuidv4();
    const newRow = toRow(newId, merged, newVec, new Date(existing.created_at), new Date(now));

    await this.table.add([newRow]);
    this.cache.push(newRow);
    return deserialiseRow(newRow);
  }

  async setEmbedding(id, embedding) {
    await this.table.update({ where: `id = '${id}'`, values: { vector: embedding } });
    const row = this.cache.find(r => r.id === id);
    if (row) row.vector = embedding;
  }

  async recall({ query, queryEmbedding, type, tags, limit = 10, mode = 'auto', asOf = null }) {
    const useVector = !!queryEmbedding && mode !== 'fulltext';
    const useText   = !!query          && mode !== 'semantic';

    const filterRow = r =>
      r.id !== '__init__' &&
      notExpired(r) &&
      isCurrent(r, asOf) &&
      (!type || r.type === type) &&
      (!tags?.length || tags.some(t => JSON.parse(r.tags || '[]').includes(t)));

    // ── Hybrid path (RRF) ────────────────────────────────────────────────────
    if (useVector && useText) {
      const [vectorResults, cacheSource] = await Promise.all([
        this.table.search(queryEmbedding).limit(60).toArray(),
        Promise.resolve(
          this.cache.length > 0
            ? this.cache
            : this.table.query().limit(10_000).toArray()
        ),
      ]);

      const vectorRanked = vectorResults.filter(filterRow);
      const textRanked   = bm25Rank(query, cacheSource.filter(filterRow));

      return rrfMerge(vectorRanked, textRanked, limit);
    }

    // ── Semantic-only path ───────────────────────────────────────────────────
    if (useVector) {
      const results  = await this.table.search(queryEmbedding).limit(limit * 3).toArray();
      const filtered = results.filter(filterRow).slice(0, limit);

      if (filtered.length) {
        return filtered.map(r => ({
          ...deserialiseRow(r),
          similarity: 1 - (r._distance ?? 0),
        }));
      }
    }

    // ── Fulltext-only path ───────────────────────────────────────────────────
    let source = this.cache;
    if (source.length === 0) {
      source = await this.table.query().limit(10_000).toArray();
    }

    const pool = source.filter(filterRow);

    if (query) {
      const ranked = bm25Rank(query, pool);
      return ranked.slice(0, limit).map(deserialiseRow);
    }

    return pool
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit)
      .map(deserialiseRow);
  }

  _pinsPath() { return path.join(DB_PATH, 'pins.json'); }

  _loadPins() {
    try { return new Set(JSON.parse(fs.readFileSync(this._pinsPath(), 'utf8'))); }
    catch { return new Set(); }
  }

  _savePins(ids) {
    fs.writeFileSync(this._pinsPath(), JSON.stringify([...ids]));
  }

  async setPin(id, pinned) {
    const ids = this._loadPins();
    if (pinned) ids.add(id); else ids.delete(id);
    this._savePins(ids);
    return true;
  }

  async listAll() {
    const pinnedIds = this._loadPins();
    const results = await this.table.query().limit(10_000).toArray();
    return results
      .filter(r => r.id !== '__init__' && !r.valid_until)
      .filter(notExpired)
      .map(r => ({ ...deserialiseRow(r), pinned: pinnedIds.has(r.id) }))
      .sort((a, b) => {
        if (b.pinned !== a.pinned) return b.pinned ? 1 : -1;
        return b.importance - a.importance;
      });
  }

  async listWithoutEmbeddings() {
    return this.cache
      .filter(r => {
        if (r.valid_until) return false; // skip tombstoned rows
        if (!r.vector) return true;
        // LanceDB may return Float32Array or plain Array — both support .every()
        // but guard against unexpected shapes (Buffer, object, etc.)
        if (typeof r.vector.every !== 'function') return true;
        return r.vector.every(v => v === 0);
      })
      .map(r => ({ id: r.id, title: r.title, content: r.content }));
  }

  async findDuplicates(threshold) {
    const rows  = this.cache.filter(r => !r.valid_until && r.vector?.some(v => v !== 0));
    const pairs = [];

    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const sim = cosineSimilarity(rows[i].vector, rows[j].vector);
        if (sim >= threshold) {
          pairs.push({
            id_a: rows[i].id, title_a: rows[i].title, type_a: rows[i].type,
            id_b: rows[j].id, title_b: rows[j].title, type_b: rows[j].type,
            similarity: sim,
          });
        }
      }
    }

    return pairs.sort((a, b) => b.similarity - a.similarity).slice(0, 20);
  }

  async mergeDuplicate(id_a, id_b) {
    const a = this.cache.find(r => r.id === id_a);
    const b = this.cache.find(r => r.id === id_b);
    if (!a || !b) return;
    if (!a.content.includes(b.content.slice(0, 40))) {
      await this.update(id_a, { content: a.content + ' | ' + b.content });
    }
    await this.delete(id_b);
  }

  async delete(id) {
    const row = this.cache.find(r => r.id === id);
    if (!row) return null;
    await this.table.delete(`id = '${id}'`);
    this.cache = this.cache.filter(r => r.id !== id);
    return row.title;
  }

  async close() {
    try { await this.table?.close(); } catch {}
    try { await this.db?.close(); } catch {}
  }
}
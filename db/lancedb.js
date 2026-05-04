// db/lancedb.js
// Zero-config embedded backend — no Docker, no server.
// Data lives in LANCEDB_PATH (default: ./.lancedb)

import { connect }          from '@lancedb/lancedb';
import { v4 as uuidv4 }     from 'uuid';
import path                 from 'path';
import fs                   from 'fs';
import { randomUUID }       from 'node:crypto'; // Built-in Node.js UUID generator

const RELATIVE_PATH = process.env.LANCEDB_PATH ?? './.lancedb';
const DB_PATH = path.resolve(process.cwd(), RELATIVE_PATH);
const TABLE   = 'memories';
const DIMS    = 1024; // voyage-3 / nomic dimensions

function rowToMemory(row) {
  return {
    id:         row.id,
    type:       row.type,
    title:      row.title,
    content:    row.content,
    tags:       JSON.parse(row.tags || '[]'),
    importance: row.importance,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    expires_at: row.expires_at ? new Date(row.expires_at) : undefined,
    source:     row.source,
    embedding:  row.vector,
  };
}

function toRow(id, input, embedding, createdAt) {
  const now = new Date();
  return {
    id,
    type:       input.type,
    title:      input.title,
    content:    input.content,
    tags:       JSON.stringify(input.tags ?? []),
    importance: input.importance ?? 3,
    created_at: (createdAt ?? now).toISOString(),
    updated_at: now.toISOString(),
    expires_at: input.expires_at ? new Date(input.expires_at).toISOString() : '',
    source:     input.source ?? 'manual',
    vector:     embedding ?? new Array(DIMS).fill(0),
  };
}

function notExpired(row) {
  return !row.expires_at || new Date(row.expires_at) > new Date();
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

export class LanceDBStore {
  constructor() {
    this.table  = null;
    this.cache  = []; // in-memory cache for filter/dedup ops
  }

  static async init() {
    // Force create the parent directory if it doesn't exist
    if (!fs.existsSync(DB_PATH)) {
        fs.mkdirSync(DB_PATH, { recursive: true });
    }
    // console.log(`🌱 Seeding fresh table: ${TABLE}`);
    const store = new LanceDBStore();
    const db = await connect(DB_PATH);
    const existing = await db.tableNames();

    if (existing.includes(TABLE)) {
      store.table = await db.openTable(TABLE);
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
          tags: ['mcp', 'lancedb', 'ai', 'personal'], 
          importance: 2
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

      console.log(`✨ Creating table: ${TABLE}`);
      store.table = await db.createTable(TABLE, rows);
    }
    // ALWAYS open the table using openTable (don't rely on the createTable return)
    try {
        store.table = await db.openTable(TABLE);
    } catch (err) {
        console.error("[aperio:db] Table created but failed to open. Retrying...");
    }

    await store.refreshCache();
    return store;
  }

  async refreshCache() {
    const results = await this.table
      .query()
      .limit(10_000)
      .toArray();
    this.cache = results.filter(r => r.id !== '__init__');
  }

  async counts() {
    await this.refreshCache();
    // Convert to Array if it's a typed array, or check for existence first
    const withEmbedding = this.cache.filter(r => {
      if (!r.vector) return false;
      // Convert any typed array or buffer to a standard array
      if (typeof r.vector.every !== 'function') return false;
      return r.vector.some(v => v !== 0);
    }).length;;
    return { total: this.cache.length, embedded: withEmbedding };
  }

  async insert(input, embedding) {
    const id  = uuidv4();
    const row = toRow(id, input, embedding);
    await this.table.add([row]);
    this.cache.push(row);
    return rowToMemory(row);
  }

  async bulkInsert(inputs) {
    if (!inputs.length) return [];
    const rows = inputs.map(input => toRow(uuidv4(), input, null));
    await this.table.add(rows);
    this.cache.push(...rows);
    return rows.map(rowToMemory);
  }

  async getById(id) {
    const row = this.cache.find(r => r.id === id);
    return row ? rowToMemory(row) : null;
  }

  async update(id, input, embedding) {
    const existing = this.cache.find(r => r.id === id);
    if (!existing) throw new Error(`Memory ${id} not found`);

    const merged = {
      type:       input.type       ?? existing.type,
      title:      input.title      ?? existing.title,
      content:    input.content    ?? existing.content,
      tags:       input.tags       ?? JSON.parse(existing.tags || '[]'),
      importance: input.importance ?? existing.importance,
      expires_at: input.expires_at ?? (existing.expires_at ? new Date(existing.expires_at) : undefined),
      source:     input.source     ?? existing.source,
    };

    const newVec = embedding !== undefined ? embedding : existing.vector;
    const newRow = toRow(id, merged, newVec, new Date(existing.created_at));

    await this.table.delete(`id = '${id}'`);
    await this.table.add([newRow]);
    this.cache = this.cache.map(r => r.id === id ? newRow : r);
    return rowToMemory(newRow);
  }

  async setEmbedding(id, embedding) {
    await this.update(id, {}, embedding);
  }

  async recall({ query, queryEmbedding, type, tags, limit = 10, mode = 'auto' }) {
    // ── Semantic path ──────────────────────────────────────────────────────
    if (queryEmbedding && mode !== 'fulltext') {
      const results = await this.table
        .search(queryEmbedding)
        .limit(limit * 3)
        .toArray();

      const filtered = results
        .filter(r => r.id !== '__init__')
        .filter(notExpired)
        .filter(r => !type || r.type === type)
        .filter(r => !tags?.length || tags.some(t => JSON.parse(r.tags || '[]').includes(t)))
        .slice(0, limit);

      if (filtered.length) {
        return filtered.map(r => ({
          ...rowToMemory(r),
          similarity: 1 - (r._distance ?? 0),
        }));
      }
    }

    // ── Fulltext fallback ──────────────────────────────────────────────────
    const lower = query?.toLowerCase() ?? '';
    // IF CACHE IS EMPTY, FETCH FROM TABLE DIRECTLY
    let source = this.cache;
    if (source.length === 0) {
        console.error("🔍 Cache empty, fetching from table...");
        source = await this.table.query().limit(limit).toArray();
    }
    return source
      .filter(notExpired)
      .filter(r => !type || r.type === type)
      .filter(r => !tags?.length || tags.some(t => JSON.parse(r.tags || '[]').includes(t)))
      .filter(r => !lower || r.title.toLowerCase().includes(lower) || r.content.toLowerCase().includes(lower))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit)
      .map(rowToMemory);
  }

  async listAll() {
    const results = await this.table.query().limit(10_000).toArray();
    return results
      .filter(r => r.id !== '__init__')
      .filter(notExpired)
      .map(rowToMemory)
      .sort((a, b) => b.importance - a.importance);
  }

  async listWithoutEmbeddings() {
    return this.cache
      .filter(r => {
        if (!r.vector) return true;
        // LanceDB may return Float32Array or plain Array — both support .every()
        // but guard against unexpected shapes (Buffer, object, etc.)
        if (typeof r.vector.every !== 'function') return true;
        return r.vector.every(v => v === 0);
      })
      .map(r => ({ id: r.id, title: r.title, content: r.content }));
  }

  async findDuplicates(threshold) {
    const rows  = this.cache.filter(r => r.vector?.some(v => v !== 0));
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
    // Embedded — nothing to close
  }
}
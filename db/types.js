// src/db/types.js

/**
 * @typedef {'fact' | 'preference' | 'project' | 'decision' | 'solution' | 'source' | 'person' | 'inference'} MemoryType
 */

/**
 * @typedef {Object} Memory
 * @property {string} id
 * @property {MemoryType} type
 * @property {string} title
 * @property {string} content
 * @property {string[]} tags
 * @property {1 | 2 | 3 | 4 | 5} importance
 * @property {Date} created_at
 * @property {Date} updated_at
 * @property {Date | null} expires_at
 * @property {Date} valid_from
 * @property {Date | null} valid_until
 * @property {number} confidence
 * @property {string} source
 * @property {boolean} pinned
 * @property {number[]} [embedding]
 */

/**
 * @typedef {Omit<Memory, 'id' | 'created_at' | 'updated_at' | 'valid_from' | 'valid_until'>} MemoryInput
 */

/**
 * @typedef {Object} RecallOptions
 * @property {string} [query]
 * @property {number[] | null} [queryEmbedding]
 * @property {MemoryType} [type]
 * @property {string[]} [tags]
 * @property {number} [limit]
 * @property {'semantic' | 'fulltext' | 'auto'} [mode]
 * @property {string} [asOf]   ISO 8601 timestamp for point-in-time recall
 */

/**
 * @typedef {Memory & { similarity?: number }} RecallResult
 */

/**
 * @typedef {Object} DedupPair
 * @property {string} id_a
 * @property {string} title_a
 * @property {MemoryType} type_a
 * @property {string} id_b
 * @property {string} title_b
 * @property {MemoryType} type_b
 * @property {number} similarity
 */

/**
 * Deserialise a raw database row from either SQLite or Postgres into a Memory object.
 * SQLite stores tags as a JSON string; Postgres stores them as a native array.
 * expires_at is always Date | null — never undefined.
 * @param {Object} row
 * @returns {Memory}
 */
export function deserialiseRow(row) {
  return {
    id:          row.id,
    type:        row.type,
    title:       row.title,
    content:     row.content,
    tags:        Array.isArray(row.tags) ? row.tags : JSON.parse(row.tags || '[]'),
    importance:  row.importance,
    created_at:  new Date(row.created_at),
    updated_at:  new Date(row.updated_at),
    expires_at:  row.expires_at ? new Date(row.expires_at) : null,
    valid_from:  new Date(row.valid_from ?? row.created_at),
    valid_until: row.valid_until ? new Date(row.valid_until) : null,
    confidence:  row.confidence ?? 1.0,
    source:      row.source ?? 'manual',
    pinned:      row.pinned === true || row.pinned === 1,
  };
}

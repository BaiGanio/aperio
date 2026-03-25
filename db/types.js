// src/db/types.js

/**
 * @typedef {'fact' | 'preference' | 'project' | 'decision' | 'solution' | 'source' | 'person'} MemoryType
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
 * @property {Date} [expires_at]
 * @property {string} source
 * @property {number[]} [embedding]
 */

/**
 * @typedef {Omit<Memory, 'id' | 'created_at' | 'updated_at'>} MemoryInput
 */

/**
 * @typedef {Object} RecallOptions
 * @property {string} [query]
 * @property {number[] | null} [queryEmbedding]
 * @property {MemoryType} [type]
 * @property {string[]} [tags]
 * @property {number} [limit]
 * @property {'semantic' | 'fulltext' | 'auto'} [mode]
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
 * @interface VectorStore
 */
// In JS, we just export an empty object or nothing if it's a type-only file.
// This prevents "Module not found" errors during imports.
export {};

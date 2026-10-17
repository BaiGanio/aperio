// lib/codegraph/resolve.js
// Backend-agnostic helpers for confidence tagging and import-target resolution.
// Kept pure (no DB) so the SQLite and Postgres backends stay in lockstep and the
// logic is unit-testable in isolation. See issue #283.

import path from 'path';

// Bump when the extraction/persistence contract changes in a way that requires
// re-indexing already-indexed repositories (e.g. gaining file/import nodes).
// A repo whose stored index_schema_version is below this is fully rebuilt on the
// next index even when file hashes are unchanged.
export const INDEX_SCHEMA_VERSION = 1;

// Synthetic per-file symbol. Emitted once per indexed file so `__file__` import
// edges have a real source/target and file-level import cycles are detectable.
export const FILE_SYMBOL_KIND = 'file';

// Confidence policy (issue #283).
export const CONFIDENCE = { EXTRACTED: 'EXTRACTED', INFERRED: 'INFERRED', AMBIGUOUS: 'AMBIGUOUS' };
export const SCORE = { EXTRACTED: 1.0, INFERRED: 0.8 };

// Map an edge kind to its relation_context bucket.
export function relationContextFor(kind) {
  switch (kind) {
    case 'calls':      return 'call';
    case 'extends':    return 'inheritance';
    case 'imports':    return 'import';
    case 'references': return 'reference';
    default:           return kind || null;
  }
}

// Local-source token the extractors emit for file-level edges (imports). The
// backend maps this to the synthetic file symbol's DB id.
export const FILE_SRC_TOKEN = '__file__';

// Candidate extensions/index files tried when resolving a relative import
// specifier to an indexed file path. Ordered — first match wins.
const RESOLVE_EXTS = ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'];
const INDEX_FILES = ['index.js', 'index.mjs', 'index.cjs', 'index.jsx', 'index.ts', 'index.tsx'];

/**
 * Resolve a relative import specifier to a repo-relative file path that exists in
 * `filePathSet`. Returns the matched path, or null when the specifier is not
 * relative or resolves to nothing indexed. Never invents a destination.
 *
 * @param {string} importerRelPath repo-relative path of the importing file
 * @param {string} specifier       the raw import module string
 * @param {Set<string>} filePathSet set of repo-relative file paths in the repo
 */
export function resolveImportTarget(importerRelPath, specifier, filePathSet) {
  if (typeof specifier !== 'string') return null;
  const spec = specifier.trim();
  // Only relative specifiers are resolvable to a local file with confidence.
  // Bare/package/absolute specifiers stay unresolved (no fabricated edge).
  if (!spec.startsWith('.')) return null;

  const dir = path.dirname(importerRelPath);
  const joined = path.normalize(path.join(dir, spec));

  for (const ext of RESOLVE_EXTS) {
    const cand = joined + ext;
    if (filePathSet.has(cand)) return cand;
  }
  for (const idx of INDEX_FILES) {
    const cand = path.join(joined, idx);
    if (filePathSet.has(cand)) return cand;
  }
  return null;
}

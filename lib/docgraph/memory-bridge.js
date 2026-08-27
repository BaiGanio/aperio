// lib/docgraph/memory-bridge.js
// Shared plumbing for the docgraph → memory bridge (#314): the deterministic
// dedup tag used by both sides of the bridge. Split out of docgraphHandlers.js
// originally so indexer.js's delete/rename lifecycle (removeFile/sweepMissing/
// deleteRepo) could retire orphaned memories without creating a circular
// import between the two. Retirement itself now lives directly inside each
// docgraph backend's own document-deletion primitives (removeOneFile,
// sweepMissingFiles, deleteDocumentsPage, finalizeRepoDelete in
// backends/postgres.js and backends/sqlite.js), sharing one transaction with
// the document delete they follow — #360 review found first (round 3, P2)
// that a plain check-then-delete race could delete a memory a concurrent
// reindex had JUST promoted for the same path, since the tag below is a hash
// of the path alone, and then (round 4, P1 & P2) that a separate purge call
// could still be fooled by an in-flight, not-yet-committed reindex, or fail
// on its own and strand a memory whose document was already deleted. Both
// close only by sharing a lock and a transaction with the document delete
// itself, which needs direct SQL against the docgraph tables — something
// only the backends have.

import { createHash } from 'node:crypto';

// Deterministic, opaque dedup tag for a document path. Combines a short
// namespace prefix ("dag:") with a SHA-256 hash truncated to 64 bits so
// the tag never contains a filesystem path and never collides with user
// tags. The namespace avoids false matches against user memories that
// happen to contain the same hex string.
export function bridgeTag(stablePath) {
  const hash = createHash('sha256').update(stablePath).digest('hex');
  return 'dag:' + hash.slice(0, 16);
}

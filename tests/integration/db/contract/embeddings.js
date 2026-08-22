// tests/integration/db/contract/embeddings.js
// A throwaway 1024-dim vector for tests that need "some embedding" without a
// real model — sized to match both SQLite's EMBEDDING_DIMS=1024 (set by
// backends.js) and Postgres's fixed vector(1024) migration columns.

export function randomEmbedding() {
  return new Array(1024).fill(0).map(() => Math.random());
}

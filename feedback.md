# Future development notes

Out-of-scope observations captured while building the DB-backed settings layer.
These are not bugs in the new code — just things worth fixing on their own.

## 1. `npm run test:store` points at a file that doesn't exist

`package.json` defines:

```
"test:store": "NODE_ENV=test node --test tests/store/store.test.js"
```

But the actual file is `tests/store/store.tests.js` (note `.tests.js`, plural).
So `npm run test:store` currently matches no file and silently runs nothing.

**Fix options:** rename the file to `store.test.js` (matches the `*.test.js`
convention used everywhere else, e.g. `backfill.test.js`, `settings.test.js`),
or point the script at a directory glob like `tests/store/`. Renaming is
cleaner and makes the file run under the normal `*.test.js` discovery.

## 2. `IDLE_TIMEOUT_SECONDS` has no code-side default

`lib/helpers/shutdownGuard.js` and `server.js` both compute the idle timeout as
`Number(process.env.IDLE_TIMEOUT_SECONDS) * 1000` with no fallback. If the var
is unset (e.g. a hand-written `.env` that omits it), this evaluates to `NaN`,
which breaks the idle-shutdown timer. `.env.example` currently sets it to `180`,
which masks the problem — so it must stay uncommented there.

**Fix:** give it a default in code, e.g.
`Number(process.env.IDLE_TIMEOUT_SECONDS) || 180`, the same pattern already used
for `HEARTBEAT_INTERVAL_SECONDS` (`|| 10`) and `SESSION_RETENTION_DAYS` (`|| 90`).
Once defaulted in code, it can be commented out in `.env.example` too.

## 3. JSONB settings are unordered

The `settings` table (migration `002_settings.sql`) stores each preference as a
JSONB `value`. JSONB does not preserve object key order. This is fine for the
preferences we're migrating (theme, sound, voice, allowed paths, reasoning
toggle — all independent scalars/objects). But if a future preference ever
needs to preserve *insertion order* of its members, store it as a JSON array
rather than relying on object key order.

---

 - db/migrations/003_codegraph.sql — cg_repos, cg_files, cg_symbols, cg_edges with FTS + HNSW indexes; embedding
  column is in from day one so v0.2 won't need a follow-up migration.
  - lib/codegraph/extract-js.js — regex-based JS/TS extractor returning {symbols, edges}. Captures functions,
  arrow consts, classes (+ extends), methods, imports, and call edges attributed to the enclosing symbol by index
  range. Parser is fully swappable for tree-sitter later — the indexer only depends on the extract() return shape.
  - lib/codegraph/indexer.js — walks a repo (skipping node_modules, dist, .git, etc.), hashes each file, skips
  unchanged ones, deletes+reinserts symbols/edges for changed files inside a transaction, then runs a name-based
  resolveEdges pass that promotes dst_unresolved → dst_symbol_id only when the name resolves uniquely in the repo.
   CLI entrypoint at the bottom.

   A few honest caveats about the v0.1 extractor:
  - Regex parser will miss/misidentify edge cases (TS generics, decorators, object-literal methods, calls inside
  template strings). Good enough to prove the MCP tool surface; tree-sitter is the right v0.2 move. 
  - Method-to-class attribution uses index-range nesting — works for normal indentation, will get confused by
  nested classes.
  - Call edges are name-only and resolved repo-wide; ambiguous names stay unresolved (the MCP tools should surface
   both buckets).

   ---

    Done. Five MCP tools wired in:

  - mcp/tools/codegraph.js — Zod schemas + registration, matching the TOOLS array pattern from memory.js.
  - lib/handlers/codegraph/codegraphHandlers.js — pure handlers reading from ctx.store.pool:
    - code_search — FTS over name + doc, optional kind filter, ranked by ts_rank.
    - code_outline — all symbols in a file by line.
    - code_context — DB lookup by qualified, then reads the actual file on disk for the source slice (with line
  numbers + padding); falls back gracefully if the repo moved.
    - code_callers / code_callees — BFS over cg_edges where kind='calls', depth capped at 5.
  - mcp/index.js — registered alongside the others.

  All five return Postgres-only — they emit a clean error message if the backend is LanceDB. No embedding/vector
  path yet (that's the v0.2 work alongside swapping in tree-sitter).

---

 Honest caveats
  - The existing test suite (tests/store/*.tests.js) is tightly coupled to LanceDB internals
  (LANCEDB_PATH, direct LanceDBStore imports). Running them against SQLite requires refactoring —
   belongs in Phase 2 alongside porting codegraph. They still pass against LanceDB unchanged.
  - FTS5 BM25 returns negative scores; my queries negate + normalize so the similarity field
  still ranges 0-1 like Postgres' ts_rank. Cosmetic differences in absolute values, but ordering
  is identical — I confirmed in the smoke tests.
  - trg_memories_mark_wiki_stale only fires on in-place UPDATE OF content, title. Since Aperio
  uses temporal versioning (tombstone + insert), this trigger doesn't fire in practice — same
  behavior as Postgres today. Not a Phase 1 regression.

  ---

  Honest caveats
  1. The migrator filters out zero-vector embeddings — LanceDB stores zero-padded rows for
  memories without embeddings, and we don't want those in vec_memories. If a user actually had a
  real-but-all-zero embedding (vanishingly unlikely), it'd be dropped.
  2. LanceDB has no lang column on memories; everything migrated gets lang='english'. That
  matches the default at the Postgres level too.
  3. The migrator does not copy wiki_article_revisions — LanceDB doesn't store article revision
  history (the archive_wiki_revision Postgres trigger has no LanceDB equivalent), so there's
  nothing to migrate. SQLite gets the trigger fresh; future updates produce revisions normally.
  4. The auto-detect "found old data" hint only fires when SQLite and LanceDB paths differ. If a
  user has explicitly set LANCEDB_PATH to the SQLite path, they won't see the hint. Edge case
  worth flagging.

  ---

    Honest end-state caveats:
  1. The store-shape duplication (store.wiki sub-store + store.cache + store.refreshCache()) is
  still in place — SQLite implements both shapes for compatibility. Could be collapsed in a
  future cleanup, but it's working code that doesn't hurt anyone. I deliberately didn't refactor
  wikiQueries.js/memoryHandlers.js to remove the dual paths — the if (store.wiki) branch is still
   exercised by both backends.
  2. The existing test suite (tests/store/store.tests.js, etc.) still references "LanceDBStore"
  in comments only — cosmetic but I left it untouched to keep the diff narrow. If you want me to
  grep through and fix those refs in one pass, say the word.
  3. package-lock.json regenerated by npm uninstall — you'll see a large lockfile delta from
  removing the lancedb native binary tree.
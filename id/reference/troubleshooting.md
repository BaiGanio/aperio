# Troubleshooting

## Agent / server won't start

| Symptom | Check |
|---------|-------|
| "Store failed to initialize" | Is the DB file writable? If Postgres: is Docker running? Is the connection string correct in `.env`? |
| Provider error / auth failure | `AI_PROVIDER` set correctly? API key env var present? Model name matches the provider's catalog? |
| Port in use | `PORT` env var (default 31337). Check `lsof -i :31337` |
| Crash loop (PROC-01) | Check `var/logs/` — 5+ fatal errors in 60s triggers crash breaker. Fix the root cause before restarting |

## Tool behavior

| Symptom | Check |
|---------|-------|
| Shell tool returns "not allowed" | `APERIO_ENABLE_SHELL` defaults to `off`. Set it to `on` |
| File reads/writes fail with path errors | The single allowed-folders list gates access (read and write alike); seeded by `APERIO_ALLOWED_PATHS`, edited in Settings → Allowed folders. Default: project root only |
| `recall()` / vector search returns nothing | Embeddings may not be generated yet. Run bootstrap or check `EMBEDDING_PROVIDER` |
| Code graph returns empty | `APERIO_CODEGRAPH` must be `on` and the repo must be indexed |

## Database

| Symptom | Check |
|---------|-------|
| SQLITE_BUSY / concurrent write errors | SQLite is single-writer. Switch to Postgres for multi-agent setups |
| Migrations fail | Are `db/migrations/` and `db/migrations-sqlite/` in sync? A migration in one but not the other causes drift |
| DB encryption key lost | Keys are stored in the OS keychain (`db/encrypt.js`). Regenerating means data loss |

## Embeddings

| Symptom | Check |
|---------|-------|
| `generateEmbedding` returns null | Embedding provider not initialized. Check `EMBEDDING_PROVIDER` (default: `transformers`). First run downloads the model — this can take a while |
| High memory usage | Local transformers load the model into RAM. Switch to `voyage` (cloud) for low-memory environments |
| Search got noticeably worse after changing `EMBEDDING_PROVIDER`, `VOYAGE_MODEL` or `EMBEDDING_DIMS` | Expected, and temporary. Those stores are marked stale in `vec_meta` and answer with full-text search only until they are reindexed — comparing new queries against vectors from the old model would return confident nonsense. Check progress with `npm run embeddings:reindex -- --status` |
| A store is stuck at `stale` or `reindexing` | The rebuild runs in the background when the server starts, so a headless or never-restarted instance may never have run it. Run `npm run embeddings:reindex`. If it reports failures, the embedding provider is unreachable — the store stays marked and resumes on the next run |
| `run_shell`/`dedup` says embeddings are being reindexed | Deliberate: dedup merges rows based on similarity, and similarity across two embedding spaces is meaningless. Wait for the reindex, or run it explicitly |
| `vec_meta` shows a `reindex_owner` that no longer exists | A runner crashed mid-reindex. The lease expires on its own (2 minutes) and the next run reclaims the store; nothing needs to be done by hand |

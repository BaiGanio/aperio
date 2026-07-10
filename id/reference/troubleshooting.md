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
| File reads/writes fail with path errors | `APERIO_ALLOWED_PATHS_TO_READ` / `APERIO_ALLOWED_PATHS_TO_WRITE` gate access. Default: project root only |
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

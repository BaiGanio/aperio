# Re: #49 — Cloud / free database alternatives for team-ready deployment

## TL;DR

The core question this EPIC raises — *"how does a team get a shared vector store?"* — is
**already answered by Aperio's existing Postgres backend.** Azure Database for PostgreSQL
Flexible Server, Supabase, and Neon are not new database *types* — they are **managed
Postgres with the `pgvector` extension**, which is exactly what Aperio's `postgres` backend
already targets.

So the real deliverable here is **not new storage adapters**. It's:

1. A **docs / deploy guide** for pointing Aperio at a hosted Postgres, and
2. **CI verification** that our migrations apply cleanly on each host (Supabase / Azure / Neon).

Everything below is grounded in the current code, with the genuine gotchas called out
honestly rather than hand-waved.

---

## Why "no new adapters" is the right call

Aperio's storage layer is a **two-backend factory** (`db/index.js`):

| Backend | Vector engine | Full-text | Intended use |
|---------|---------------|-----------|--------------|
| **SQLite** (`db/sqlite.js`) | `sqlite-vec` | FTS5 | Single user, zero-config, no Docker |
| **Postgres** (`db/postgres.js`) | **`pgvector`** (HNSW) | `tsvector` + GIN | Multi-agent / team / production |

A hosted Postgres provider is just **someone else running the Postgres box for you.** From
Aperio's side, the wire protocol, the SQL, the `pgvector` operators (`<=>`), and the HNSW
index are all identical. There is nothing provider-specific to implement.

Concretely, the Postgres store connects with nothing but a connection string
(`db/postgres.js`):

```js
static async init() {
  assertNonDefaultDbUrl(process.env.DATABASE_URL);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations(pool);
  return new PostgresStore(pool);
}
```

Point `DATABASE_URL` at Supabase / Azure / Neon and this is unchanged.

---

## How a team actually turns it on today

There is **one non-obvious step**: the backend auto-detector only recognises a *local Docker
container named `aperio_db`* (`db/index.js` → `isPostgresContainerRunning`). It will **not**
auto-detect a hosted Postgres. So for a cloud DB you must select the backend explicitly:

```bash
# .env
DB_BACKEND=postgres                                   # explicit — auto-detect won't find a hosted DB
DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require
```

```bash
npm run migrate      # applies db/migrations/*.sql to the hosted Postgres
npm run start:cloud  # or start:local — Aperio now uses the shared DB
```

`DB_BACKEND=postgres` always wins over auto-detection (see `resolveBackend()`), which is
exactly what we want for a remote host.

---

## The real compatibility gate: two extensions

Our first migration (`db/migrations/001_init.sql`) opens with:

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;       -- pgvector: vector(1024) + HNSW
```

This is the **entire** compatibility surface. If a host lets these two extensions be
created, Aperio works. Provider-by-provider:

| Host | `pgvector` | Gotcha |
|------|-----------|--------|
| **Supabase** | ✅ built in | Enable `vector` + `pgcrypto` (dashboard → Extensions, or `create extension`). The default `postgres` role may create them. |
| **Neon** | ✅ built in | `CREATE EXTENSION vector` works out of the box. |
| **Azure Flexible Server** | ✅ supported | **Must allow-list first:** add `vector` (and `pgcrypto`) to the **`azure.extensions`** server parameter before `CREATE EXTENSION` will succeed. This is a one-time portal/CLI step and is the single most likely thing to trip someone up. |

Additional real constraints (worth documenting, not blocking):

- **HNSW index** (`USING hnsw`) requires **pgvector ≥ 0.5.0**. All three hosts ship a recent
  pgvector, so this is fine today — but it's the version floor to state.
- **`vector(1024)`** is a fixed dimension in the schema. The embedding provider must emit
  1024-dim vectors (e.g. `mxbai-embed-large`). A mismatched `EMBEDDING_DIMS` will fail on
  insert — this is provider config, not a hosting issue, but it surfaces here.
- **SSL:** managed Postgres requires TLS. The pool is built from the connection string only
  (no explicit `ssl` object), so the URL must carry `?sslmode=require`. Supabase / Neon /
  Azure present certificates that chain to public CAs, so `sslmode=require` is sufficient; no
  custom CA bundle is needed. (If a host ever presents a self-signed cert, node-postgres's
  `sslmode=no-verify` is the escape hatch.)
- **Default-password guard:** `assertNonDefaultDbUrl()` refuses the shipped example password
  (`aperio_secret`). Hosted DBs have real credentials, so this is a non-issue for them.

---

## Where I'd push back on the EPIC as written

The issue also lists **ChromaDB, Qdrant, and Redis** as candidates. I'd explicitly **not**
pursue those as backends:

- Each is a **third storage abstraction** to build and maintain alongside the SQLite/Postgres
  split — its own query translation, migration story, and test matrix — for capability we
  **already have** via `pgvector`.
- Dedicated vector databases start earning their keep past **~10M vectors** or with heavy
  filtered-ANN workloads. A personal/team memory layer is nowhere near that scale.
- It would fragment the codebase for zero user-visible gain over "managed Postgres."

The **one** genuinely interesting alternative in the list is **Turso / libSQL** — "SQLite,
but network-shared." It could give very light teams a shared store *without* standing up
Postgres. The risk is libSQL's `sqlite-vec` support and the `better-sqlite3` driver
assumptions in `db/sqlite.js`. That deserves a **time-boxed spike**, not a commitment.

---

## Suggested acceptance criteria (to move this from "thinking on it…" to work)

**Do:**
- [ ] Deploy guide: `DB_BACKEND=postgres` + `DATABASE_URL` for **one** officially-supported
      host (recommend **Supabase** for the free tier, plus **Azure** if that's the deployment
      story). Include the Azure `azure.extensions` allow-list step.
- [ ] CI job: run `npm run migrate` + the store test suite against a hosted-style pgvector
      (a `pgvector/pgvector` container is a faithful stand-in) to guarantee the migrations
      stay host-compatible.
- [ ] Document the version floor (pgvector ≥ 0.5) and the 1024-dim embedding requirement.

**Skip:**
- [ ] ~~New Chroma / Qdrant / Redis adapters~~
- [ ] ~~A "pick-your-vector-DB" abstraction layer~~
- [ ] ~~Committing to Turso before a spike~~

**Spike (optional):**
- [ ] Turso / libSQL as a shared-SQLite option — evaluate `sqlite-vec` + driver compatibility.

---

*Bottom line: this EPIC is ~90% already shipped. Reframe it from "add database alternatives"
to "document + CI-verify managed-Postgres deployment for teams," and it becomes a small,
high-credibility win instead of an open-ended survey.*

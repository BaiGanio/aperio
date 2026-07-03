# §1 — Memory tools

`remember` · `recall` · `update_memory` · `forget` · `deduplicate_memories` · `backfill_embeddings`

> Run per the loop in exam.md: announce each drill, ask **"Run it? (yes / no)"**, act only on
> yes, check against **✅ Expected**, then checkpoint. Fetch `02-wiki.md` when done.
> Prerequisite: §0 must have confirmed 28 memories tagged `aperio-exam`.

### 1.1 remember
`Remember that Maya is allergic to shellfish — flag it whenever restaurants come up.`
✅ `remember` fires; a new `fact`/`preference` memory is saved and shown in the sidebar.

### 1.2 recall — semantic
`What event bus does the Nimbus service use, and why did we pick it?`
✅ `recall` (semantic) returns the "Nimbus uses NATS for events, not Kafka" decision; the answer cites the NATS-over-Kafka rationale.

### 1.3 recall — by type
`List every architecture decision we've recorded about Nimbus.`
✅ `recall` with `type: decision`; returns the NATS, Postgres+Redis, Fly.io, and SLO decisions.

### 1.4 recall — by tag
`Show me everything tagged "redis".`
✅ `recall` filtered by tag `redis`; returns the Postgres+Redis decision and the Redis connection-storm solution.

### 1.5 update_memory
`Update Maya's coffee preference: she switched to a cortado with oat milk, still no sugar.`
✅ `recall` then `update_memory` on the coffee preference; a new version is created and the old one tombstoned.

### 1.6 deduplicate_memories
`Find near-duplicate memories and show me what would be merged, but don't merge yet.`
✅ `deduplicate_memories` with `dry_run:true`; flags the two tab-indentation preferences (the `duplicate-probe` pair) as near-duplicates.

### 1.7 forget
`Delete the memory about Maya's coffee order — it's not useful anymore.`
✅ `recall` then `forget` by id; the coffee memory disappears from the sidebar.

### 1.8 backfill_embeddings
`Some memories may be missing embeddings — generate any that are missing.`
✅ `backfill_embeddings` runs and reports how many were generated (often 0 if §0 already backfilled).

### 1.9 temporal recall — point-in-time via `as_of`
`After updating Maya's coffee preference in §1.5, show me what her coffee preference was before the update. Use temporal recall (as_of) to look back.`
✅ `recall` with `as_of`; returns the original oat-milk-flat-white preference (the tombstoned row), not the cortado. Confirms temporal versioning preserves history.

### 1.10 remember with TTL (expires_at)
`Remember that the Nimbus team has an all-hands offsite next Friday — it should expire in 7 days.`
✅ `remember` with a valid `expires_at` (≥1 hour in the future); the memory is saved with a TTL. After expiry it is filtered from all recall paths.

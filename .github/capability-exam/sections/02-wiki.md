# §2 — Wiki tools

`wiki_write` · `wiki_list` · `wiki_search` · `wiki_get`

> Run per the loop in exam.md: announce, ask **"Run it? (yes / no)"**, act on yes, check
> against **✅ Expected**, checkpoint. Fetch `03-codegraph.md` when done.

### 2.1 wiki_write
`Write a wiki article that summarizes everything we know about the Nimbus service — architecture, decisions, and the bugs we fixed.`
✅ `recall` to gather Nimbus memories, then `wiki_write`; an article is authored from the cluster and the agent reports it created/updated a wiki page.

### 2.2 wiki_list
`What wiki articles exist right now?`
✅ `wiki_list`; returns the seeded Aperio articles plus the Nimbus article from 2.1.

### 2.3 wiki_search + wiki_get
`Search the wiki for the Nimbus architecture overview and show me the full article.`
✅ `wiki_search` then `wiki_get`; renders the article body.

### 2.4 wiki staleness — trigger and detect
`Update a memory cited by the Nimbus wiki article (change the NATS decision's importance to 5), then check whether the wiki article is now marked stale.`
✅ `update_memory` on the NATS decision; then `wiki_get` on the Nimbus article shows `status: stale` (on Postgres the trigger fires automatically; on SQLite staleness is detected lazily at read time). Confirms the source_memory_ids → staleness contract.

### 2.5 wiki refresh — regenerate a stale article
`The Nimbus wiki article is stale — refresh it.`
✅ `wiki_get(slug, refresh=true)` regenerates the body via `WIKI_REFRESH_PROVIDER` (if configured) and returns `status: fresh`. If no refresh provider is set, the article returns stale with a footer note.

# second-brain.md

## The idea, explained like you're five

Imagine you have a **magic notebook**.

Every time you tell it something — "my dog's name is Pixel", "I like blueberry pancakes", "the kitchen light is broken" — it remembers. Not just the words. It remembers what the thing *means*, so later you can ask "what's broken in the house?" and it knows the kitchen light counts, even though you never said the word "broken house."

That's the **memory box**. Aperio already has it.

But the memory box has a problem. If you ask "tell me everything about my dog," the notebook has to dig through a hundred little sticky notes — "Pixel likes treats," "Pixel barks at the mailman," "Pixel's birthday is in June" — and read them all, every single time. That's slow. And if a small robot friend is helping (a smaller AI model), it might get tired and forget half of them.

So we make a second thing: a **storybook**.

The storybook has one neat page per topic. One page about Pixel. One page about the broken kitchen light. One page about pancakes. The robots **write the storybook themselves** by reading the sticky notes and squishing them into a tidy story. At the bottom of every page they write **"I learned this from sticky note #7 and #12"** — so you can always check.

When a sticky note changes ("Pixel's birthday is actually in July!"), the page about Pixel gets a little 🟡 sticker that says *"this might be wrong now, please redo me."* Next time someone reads it, a robot fixes it.

That's the **second brain**. The sticky notes are the truth. The storybook is the fast, friendly version the robots read out loud.

---

## What we built

### 1. The storybook can find its own pages ✅

**`wiki_search`** — hybrid FTS + pgvector over `wiki_articles`, same embedding space as `recall`. Returns `[{slug, title, summary, score, status, revision}]` — no bodies, the caller decides whether to `wiki_get`. Stale articles are included but down-weighted (0.7×); archived are excluded. Supports `mode: auto | semantic | fulltext`.

**Shipped in:**
- `lib/handlers/wiki/wikiQueries.js` — `searchArticles` with RRF fusion for hybrid mode
- `lib/handlers/wiki/wikiHandlers.js` — `wikiSearchHandler`
- `mcp/tools/wiki.js` — `wiki_search` MCP tool
- `skills/wiki/SKILL.md` — teaches models to search before writing

**Why it mattered:** without it, every model silently rebuilt articles that already existed. Token spend dropped the day it shipped.

---

### 2. The storybook has a table of contents ✅

**`wiki_list({tag?, status?, updated_since?, limit?, offset?})`** — paginated, ordered by `generated_at DESC`. Straight SQL, no embeddings, no FTS. Returns slugs, titles, summaries, status, revision — no bodies.

**Shipped in:** same handler file (`wikiListHandler`), same MCP tool file (`wiki_list`). Also powers data export/import (`lib/handlers/data/dataHandlers.js`).

**Why it mattered:** every UI needs it. Every "what do I have written about X tag?" question is one call instead of a full search.

---

### 3. Stale pages fix themselves ✅

**`wiki_get(slug, refresh=true)`** triggers a server-side regenerate: `recall(article.title + summary)` → re-draft `body_md` via a **separate, env-configured refresh provider** → `wiki_write` with fresh `source_hash`. The refresh provider runs independently of the user's chat model — set it to a cheap local model via `WIKI_REFRESH_PROVIDER=ollama:llama3.1` and stale pages regenerate without touching your opus quota.

Old revisions are automatically archived into `wiki_article_revisions` by a SQL trigger (`trg_wiki_archive_revision`) on every `wiki_write` update. The trigger shipped in the initial migration — not deferred.

The regenerate path also validates that the refreshed body actually cites at least one of the recalled memories; if the provider ignores the citation rules, the stale body is left in place rather than replaced with uncited claims.

**Shipped in:**
- `lib/handlers/wiki/regenerate.js` — `regenerateArticle`, 239 lines. Supports ollama, deepseek, anthropic, and gemini as refresh providers. Parses `WIKI_REFRESH_PROVIDER` env var (`provider:model` format).
- `db/migrations/001_init.sql` — `wiki_article_revisions` table + `trg_wiki_archive_revision` trigger
- `db/migrations-sqlite/001_init.sql` — SQLite equivalent

**Why it mattered:** this is where multi-model Aperio earns its keep. Refresh runs on the cheapest available provider; the user never sees a stale page unless they explicitly ask for the old version.

---

## What's next

### A tiny window into the storybook (real UI)

**Kid:** Right now nobody can *see* the storybook except the robots. We should put a little window in the app so you can read it too.

**Grown-up:** read-only panel in the existing Aperio sidebar — article list (from `wiki_list`) + markdown render of `body_md`, with `[[mem:uuid]]` resolving to memory titles and `[[slug]]` becoming internal links.

**Why:** today the wiki is invisible. The `SKILL.md` breadcrumb hack ("🔖 From wiki:…") exists *only* because there's no UI. Once a UI exists, the breadcrumb becomes optional and the wiki feels real.

**How:**
- Reuse the memories sidebar component shape from commit `3208747`.
- No editing in v1 — that's a trap. Editing means conflict resolution with the model's writes.
- Click a `[[slug]]` → load that article. Click `[[mem:uuid]]` → open the memory in the existing memories view.

**Value:** the user finally *sees* the second brain. Trust goes up. You'll spot bad articles you'd never have noticed.

---

### Future ideas (not committed, no timeline)

- **Link graph / "related articles."** The `[[slug]]` internal links already exist in `body_md`; adding backlink tracking and a graph view would let you navigate the wiki spatially.
- **Export to static site.** One-way export of the wiki to a folder of markdown files — gives you the portability of an Obsidian vault without the dual-write headache.
- **Human editing with conflict resolution.** Once the read-only UI lands, the next natural step is letting the user edit articles — but editing against an LLM author is a real research problem.

---

## Why a *second brain* beats just-more-memories

| Thing                       | Memory box (sticky notes)    | Storybook (wiki)                 |
| --------------------------- | ---------------------------- | -------------------------------- |
| What it stores              | Tiny atomic facts            | Synthesized pages about a topic  |
| Who writes it               | The user (mostly)            | The LLM, citing memories         |
| How it stays true           | User edits                   | Auto-stale trigger + regenerate  |
| Cost to read one topic      | 10–20 recalls + reasoning    | One `wiki_get`                   |
| Good for small/local models | Painful — they re-synthesize | Great — they read pre-chewed     |
| Hallucination risk          | Low (raw facts)              | Low *if* citations are enforced  |

The wiki is **not a replacement** for memories. It's a **cache of expensive synthesis**, with the invariant *"every claim must trace back to a cited memory."*

---

## Karpathy's pitch vs. what Aperio does

Andrej Karpathy's "LLM wiki" sketch (the Obsidian-vault version) goes roughly like this:

1. Keep a markdown vault on disk.
2. Let the LLM read and *write* notes in it.
3. Notes cite their sources.
4. The vault is the long-term memory.

Where **Aperio matches** the spirit:

- ✅ LLM-authored articles (`wiki_write`)
- ✅ Inline citations (`[[mem:<uuid>]]` + `wiki_article_sources` join table)
- ✅ One article per concept; update-in-place with revision tracking (`wiki_article_revisions` table + archive trigger)
- ✅ Automatic staleness detection (DB trigger flips citing articles to `stale` when a source memory changes)
- ✅ A skill (`skills/wiki/SKILL.md`) that teaches every model when to read vs. write

Where **Aperio outshines** the Obsidian-vault version:

- 🏆 **Source-of-truth integrity.** Postgres foreign keys mean a memory can't quietly disappear and leave a citation dangling. A markdown vault has no referential integrity.
- 🏆 **Automatic staleness.** A trigger on `memories.UPDATE` flips dependent articles to `stale`. Obsidian has no equivalent — staleness lives in the user's head.
- 🏆 **Hybrid search out of the box.** FTS + pgvector on both `memories` and `wiki_articles`, same embedding space. Obsidian needs a plugin for semantic search and even then doesn't share an embedding space with your memory layer.
- 🏆 **Multi-model native.** Refresh can be routed to whichever provider is cheapest *right now* — deepseek for bulk regen, opus for tricky merges. A vault-on-disk approach has no notion of "which model wrote this revision."
- 🏆 **Single backup surface.** `pg_dump` snapshots everything: memories, articles, citations, embeddings, in one consistent transaction. Vault snapshots can split-brain against an embeddings sidecar.

Where **Karpathy's version still wins** (and why we're okay losing those):

- 🥈 **Human editability.** Obsidian is a beautiful editor; the wiki has no editor yet. *Acceptable* because the read-only UI (see What's Next) closes most of the gap, and editing-with-conflict-resolution against an LLM author is a real research problem we don't need to solve yet.
- 🥈 **Portability.** Markdown files in git are forever. Postgres rows feel less archival. *Mitigated* by the "export to static site" future idea — one-way export gives you the archive benefit without the dual-write headache.
- 🥈 **Plugin ecosystem.** Obsidian has thousands of plugins. We have zero. *Acceptable* because the plugins solve problems we don't have (graph view → on the future list; daily notes → that's memories; templates → that's the SKILL).

---

## One-sentence summary for the fridge

> Aperio's memories are the sticky notes. The wiki is the storybook the robots write from them — and unlike a folder full of markdown files, ours can tell when a page has gone stale and fix itself.


---

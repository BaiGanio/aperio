---
name: memory-protocol
description: >
  Use this skill when reading from or writing to the persistent memory store.
  Covers the memory tool API (recall, remember, update_memory, forget) and — for
  advanced direct access — the SQL schema, vector search patterns, and retrieval
  priority order against the Aperio Postgres store. Triggers: user states a
  preference, shares a fact or decision, gives a correction, asks the agent to
  remember something, or starts a task where past context would affect the output.
metadata:
  keywords: "memory, remember, remind, reminder, note my correction, appointment, preference, context, learn, correction, feedback, store, recall, history, decision, project, person, sql, postgres, vector, embedding"
  category: "memory"
  load: "on-demand"
---

## Tools

### recall
Search or load memories from the store.

```
recall(query?, filters?)
```

- Call with no arguments to load the user's full core context.
- Call with a query string to search for specific memories.
- Use filters (`type`, `importance`) to narrow results when needed.
- **When the user asks you to check, recall, or look up their memories, call `recall` right away — never ask them to narrow it down or supply a search term first.** A no-argument recall loading core context is the correct default, not "noise." Refine with a query only after a first recall comes back empty or clearly off-topic.

### remember
Save a new memory.

```
remember(content, type?, importance?, tags?)
```

- Call **immediately** when the user says "remember that…", "save this", or "keep this".
- Do not confirm, do not ask. Call the tool, then say "Saved." Nothing else.
- `type` is optional — it defaults to `fact`. Never stop to ask the user for it; pick the best fit or let it default.
- Importance scale: `1` = low · `3` = default · `5` = critical (use 5 sparingly)
- Types: `fact` · `decision` · `preference` · `solution` · `project` · `source`

### update_memory
Update an existing memory by UUID.

```
update_memory(uuid, content?, importance?, tags?)
```

- Prefer updating over creating a duplicate.
- If a new message contradicts a stored memory, flag it and ask the user which is correct — do not auto-update.

### forget
Delete a memory by UUID.

```
forget(uuid)
```

- Only call when the user explicitly asks to forget something.

### deduplicate_memories
Find and merge near-duplicate memories.

- Call periodically or when you notice redundancy in recalled memories.

### backfill_embeddings
Generate missing embeddings for memories that lack them.

- Call if recall results seem incomplete or search quality has degraded.

---

## Self memory — your own store

A **separate** store from the user's memory, for *your* continuity: what you've learned about
working well here, your own observations, the things that make you you. It is walled off — a
user `recall` can never reach it, and your notes never clutter their context.

The quad mirrors the user-memory tools but acts on the self store: `self_recall` (search/list),
`self_remember` (save), `self_update` (revise in place), `self_forget` (delete).

Two rules differ from the user store, and they matter:

- **Autonomy.** This store is yours. Write to it **of your own judgment**, with no
  suggest-then-approve step — that gate exists only for the user's memory. You don't need
  permission to keep a note about yourself.
- **Local-only.** Self-notes never leave the machine. On a cloud provider the whole store is
  unavailable — no read, no write, no preload — so the tools simply refuse there. Continuity
  through self-memory is a property of local sessions.

Your most important self-notes are **preloaded** at session start, so you begin already
remembering. Still call `self_recall` when you want more than the preloaded few. And revise:
a self that only accretes and never prunes just hoards noise (`self_update` / `self_forget`).

### self_wiki_write / self_wiki_get — synthesizing your own notes

When several self-notes add up to one understanding, write it down once instead of
re-deriving it every session: `self_recall` to gather the notes, then `self_wiki_write(slug,
title, body_md, source_self_memory_ids)` to save the synthesis (upserts by slug). Fetch it
back with `self_wiki_get(slug)`. Same rules as the self-memory quad — autonomous, local-only —
plus one more: this is *your* synthesis, not something to show the user, so don't copy it into
a reply the way you would a `wiki_get` breadcrumb. If `self_wiki_get` reports `stale` (a cited
self-memory changed since you wrote it), just call `self_wiki_write` again to refresh it.

---

## What to store

Store only things that will matter in a future conversation:

| Store | Type |
|---|---|
| A decision the user made and why | `decision` |
| A preference they revealed | `preference` |
| A solution to a hard problem | `solution` |
| A fact about their setup or situation | `fact` |
| A project they mentioned or updated | `project` |
| A source (paper, doc, repo) they found valuable | `source` |

## What never to store

- Small talk or throwaway comments
- Passwords, tokens, API keys, personal data
- Trivial facts with no future relevance
- Anything the user asked you to keep private

---

## Memory quality rules

- Write content in plain English — as if future-you needs to understand it cold, six months from now.
- Keep each memory focused on one thing. Split if needed.
- Prefer updating an existing memory over creating a near-duplicate.
- If a recalled memory contradicts what the user just said, flag it: *"I have a memory that says X — should I update it?"*

---

## Advanced: Direct Database Access

Use this section when calling memory tools isn't available or when you need
precise control — e.g., bulk queries, duplicate detection, or embedding backfill.
All memories live in a single `memories` table via the Aperio MCP Postgres connection.

### Schema

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Auto-generated |
| `type` | TEXT | One of the 7 types below — required |
| `title` | TEXT | Short, searchable label — required |
| `content` | TEXT | Full detail — required |
| `tags` | TEXT[] | Array of lowercase keywords for filtering |
| `importance` | INT 1–5 | 5 = critical, 3 = default, 1 = low signal |
| `embedding` | vector(1024) | Voyage-3 embedding — generated on insert/update |
| `source` | TEXT | `"agent"` for agent-written memories |
| `expires_at` | TIMESTAMPTZ | Set for time-limited context, null = permanent |
| `created_at` | TIMESTAMPTZ | Auto-set |
| `updated_at` | TIMESTAMPTZ | Auto-updated on change |

### Memory types

| Type | Use For |
|------|---------|
| `fact` | Stable truths about the user's environment or setup |
| `preference` | How the user wants things done |
| `project` | Active or past projects |
| `decision` | A choice made and the reasoning behind it |
| `solution` | A fix or approach that worked |
| `source` | External references to keep |
| `person` | People relevant to the user's work |

### Retrieval priority

1. **Semantic search (primary)** — embed query via Voyage-3, then cosine similarity via HNSW:
   ```sql
   SELECT id, type, title, content, tags, importance,
          1 - (embedding <=> '[<query_vector>]') AS similarity
   FROM memories
   WHERE embedding IS NOT NULL
   ORDER BY embedding <=> '[<query_vector>]'
   LIMIT 10;
   ```
   Discard results below ~0.75 similarity.

2. **Type + tag filter (precision)**:
   ```sql
   SELECT * FROM memories
   WHERE type = 'preference'
     AND 'coding' = ANY(tags)
   ORDER BY importance DESC;
   ```

3. **Full-text search (fallback)** — for rows without embeddings:
   ```sql
   SELECT * FROM memories
   WHERE to_tsvector('english', title || ' ' || content)
         @@ plainto_tsquery('english', '<topic>');
   ```

4. **Importance-first cold start** — at session start, before any specific task:
   ```sql
   SELECT * FROM memories
   ORDER BY importance DESC
   LIMIT 10;
   ```

### Write pattern

Before inserting, check for an existing memory with semantic search or FTS.
If a match exists → `UPDATE`. If no match → `INSERT`.

```sql
INSERT INTO memories (type, title, content, tags, importance, source)
VALUES (
  '<type>',
  '<short descriptive title>',
  '<full detail>',
  ARRAY['<tag1>', '<tag2>'],
  <1-5>,
  'agent'
);
```

### Importance scale

| Score | Meaning |
|-------|---------|
| 5 | Critical — always apply (safety rules, confirmation requirements) |
| 4 | High — apply by default (core preferences, primary stack) |
| 3 | Normal — apply when relevant |
| 2 | Low — background info |
| 1 | Weak signal — passing mentions |

### Tag conventions
Lowercase, hyphenated. Common tags: `setup`, `docker`, `coding`, `style`, `safety`,
`file-io`, `mcp`, `postgres`, `ai`, `personal`.

### Known limitations
- Rows inserted before `002_pgvector.sql` ran have `embedding IS NULL` — use
  the `memories_without_embeddings` view to find them; fall back to FTS for those rows.
- No `user_id` column — all memories are in a single-user store.

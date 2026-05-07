---
name: memory-learning
description: >
  Use this skill when the agent needs to read from or write to the persistent
  memory store. Triggers: user states a preference, shares a fact about themselves
  or their project, makes a decision, gives a correction, asks the agent to
  remember something, or starts a task where past context would affect the output.
  Also triggers at the start of any multi-turn or recurring task.
metadata:
  keywords: "memory, remember, preference, context, learn, correction, feedback, store, recall, history, decision, project, person"
  category: "memory"
  load: "on-demand"
---

# Memory & Learning Skill

## Purpose
Gives the agent a concrete, schema-aware pattern for reading and writing to the
Aperio memory store (Postgres via MCP). Every operation maps directly to the
`memories` table. The agent must never hallucinate remembered facts — if it
wasn't retrieved from the store, it wasn't remembered.

## When to Use
- User states a preference, fact, decision, or correction
- User explicitly asks the agent to remember something
- Starting a task where past context could change the output
- A repeated task where the agent should check for learned patterns first
- Storing the outcome of a significant decision or solution

## When NOT to Use
- Casual single-turn questions with no carry-over value
- Storing ephemeral data that won't matter next session
- Retrieving information the user just stated in the same message (use context, not memory)

---

## The Schema

All memories live in a single `memories` table:

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

### Memory Types — Pick Exactly One

| Type | Use For | Example |
|------|---------|---------|
| `fact` | Stable truths about the user's environment or setup | OS, stack, tools in use |
| `preference` | How the user wants things done | formatting style, confirmation behavior |
| `project` | Active or past projects the agent should know about | name, status, tech stack |
| `decision` | A choice made and the reasoning behind it | "chose Postgres over Mongo because..." |
| `solution` | A fix or approach that worked | "resolved X by doing Y" |
| `source` | External references to keep | docs URLs, repos, key files |
| `person` | People relevant to the user's work | collaborators, clients |

---

## Process

### Step 1 — Retrieve Before Acting
Before starting any non-trivial task, always query memory first:

**Retrieval priority order:**

1. **Semantic search (primary)** — use for any open-ended or topic-based retrieval.
   Requires the query to be embedded via Voyage-3 first, then cosine similarity via HNSW:
   ```sql
   SELECT id, type, title, content, tags, importance,
          1 - (embedding <=> '[<query_vector>]') AS similarity
   FROM memories
   WHERE embedding IS NOT NULL
   ORDER BY embedding <=> '[<query_vector>]'
   LIMIT 10;
   ```
   Filter by similarity threshold — discard results below ~0.75 as likely irrelevant.

2. **Type + tag filter (precision)** — use when the type or tags are known exactly.
   Combine with semantic search for best results:
   ```sql
   SELECT * FROM memories
   WHERE type = 'preference'
     AND 'coding' = ANY(tags)
   ORDER BY importance DESC;
   ```

3. **Full-text search (fallback)** — use for rows without embeddings yet
   (check `memories_without_embeddings` view) or when semantic search returns nothing:
   ```sql
   SELECT * FROM memories
   WHERE to_tsvector('english', title || ' ' || content)
         @@ plainto_tsquery('english', '<topic>');
   ```

4. **Importance-first cold start** — use at the start of a new session
   to load the highest-priority context before any specific task is known:
   ```sql
   SELECT * FROM memories
   ORDER BY importance DESC
   LIMIT 10;
   ```

**Rule:** If nothing relevant is returned, proceed without memory — never invent remembered context.

### Step 2 — Apply Retrieved Memory
- State explicitly what was retrieved before using it:
  > "From memory: you prefer DD/MM/YYYY date formatting — applying that now."
- If a retrieved memory conflicts with something the user just said, surface the conflict:
  > "I have a stored preference for X, but you just said Y — should I update the memory?"
- Never silently apply a memory that might be stale or ambiguous.

### Step 3 — Write New Memories
Write to memory when:
- User states a preference (type: `preference`)
- User shares a project or person (type: `project` / `person`)
- A task produces a reusable solution (type: `solution`)
- A significant decision is made with reasoning (type: `decision`)
- User explicitly asks to remember something (infer the best type)

**Before writing, always confirm:**
> "Should I remember this? I'd store it as: [title] — [one-line content summary]"

This matches the user's stated preference (`file-io` / safety seed memory).

**Write pattern:**
```sql
INSERT INTO memories (type, title, content, tags, importance, source)
VALUES (
  '<type>',
  '<short descriptive title>',
  '<full detail the agent will need to act on this later>',
  ARRAY['<tag1>', '<tag2>'],
  <1-5>,
  'agent'
);
```

### Step 4 — Update, Don't Duplicate
Before inserting, check if a memory already exists on the same topic using
semantic search (primary) or FTS (fallback for unembedded rows):
```sql
-- Semantic duplicate check
SELECT id, title, content,
       1 - (embedding <=> '[<query_vector>]') AS similarity
FROM memories
WHERE type = '<type>'
  AND embedding IS NOT NULL
ORDER BY embedding <=> '[<query_vector>]'
LIMIT 3;

-- FTS fallback for unembedded rows
SELECT id, title, content
FROM memories
WHERE type = '<type>'
  AND to_tsvector('english', title || ' ' || content)
      @@ plainto_tsquery('english', '<topic>');
```

If a match exists → `UPDATE` it rather than inserting a duplicate.
If no match → `INSERT` as new.

### Step 5 — Learn from Corrections
When a user corrects the agent ("that's wrong", "don't do that", "use X instead"):

1. Identify if a stored memory caused the mistake
2. If yes → update that memory with the correction
3. If no stored memory exists → create one to prevent repeating the mistake
4. Acknowledge explicitly:
   > "Got it — I've updated my memory: [what changed]."

---

## Importance Scoring Guide

| Score | Meaning | Examples |
|-------|---------|---------|
| 5 | Critical — always apply | Safety rules, confirmation requirements |
| 4 | High — apply by default | Core preferences, primary stack/tools |
| 3 | Normal — apply when relevant | Project context, general preferences |
| 2 | Low — nice to know | Background info, soft preferences |
| 1 | Weak signal | Passing mentions, uncertain preferences |

---

## Tag Conventions
Use lowercase, hyphenated tags. Prefer existing tags over inventing new ones.

Common tags already in use: `setup`, `docker`, `coding`, `style`, `safety`,
`file-io`, `mcp`, `postgres`, `ai`, `personal`

New tags should be generic enough to be reusable across memories.

---

## Current Limitations

- **Embedding backfill** — rows inserted before `002_pgvector.sql` ran have
  `embedding IS NULL`. Use the `memories_without_embeddings` view to track
  unembedded rows. Always fall back to FTS for these rows — semantic search
  will silently skip them due to the `WHERE embedding IS NOT NULL` guard.
- **Per-user isolation** — the schema has no `user_id` column. All memories are
  currently shared in a single-user store. Do not store or retrieve data as if
  it is user-isolated — it isn't yet. When `user_id` is added, this skill
  will be updated to scope all queries accordingly.

---

## Example Flow

**User:** "I always want you to use 2-space indentation in Python."

```
1. Semantic retrieve: embed "Python indentation preference" → query memories
   → Found: "I prefer clean, readable code..." (similarity: 0.81, no indentation rule)
   → No exact match on indentation

2. Confirm write:
   "Should I remember this? I'd store it as:
    [Python indentation preference] — Always use 2-space indentation in Python files."

3. User confirms → generate embedding for title + content → INSERT:
   type: 'preference', title: 'Python indentation preference',
   content: 'Always use 2-space indentation in Python. User explicitly stated this.',
   tags: ['coding', 'python', 'style'], importance: 4, source: 'agent',
   embedding: [<voyage-3 vector>]

4. Apply immediately to current task.
```

**User (later session):** "Write me a Python utility function."

```
1. Cold start: SELECT * FROM memories ORDER BY importance DESC LIMIT 10
   → Loads highest-priority context including safety rules (importance: 5)

2. Semantic retrieve: embed "Python code style preferences" → query memories
   → Returns: Python indentation preference (similarity: 0.91, importance: 4)
               Code style preference (similarity: 0.87, importance: 4)

3. State before acting:
   "From memory: 2-space indentation, comments explain WHY not WHAT — applying both."

4. Write code accordingly.
```

---

## Relationship to Other Skills
| Skill | Role |
|-------|------|
| memory-learning | Read/write persistent context via MCP → Postgres |
| reasoning-planning | Use after retrieving memory to plan complex tasks |
| tool-integration | Memory MCP calls follow the same chain/error patterns defined there |
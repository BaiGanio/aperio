---
name: memory-protocol
description: >
  This skill defines how to use memory tools. Load it whenever you are reading, writing, or managing memories.
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

### remember
Save a new memory.

```
remember(content, type, importance?, tags?)
```

- Call **immediately** when the user says "remember that…", "save this", or "keep this".
- Do not confirm, do not ask. Call the tool, then say "Saved." Nothing else.
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

## File tools

### read_file
Read a file from disk.

```
read_file(path)
```

- Always use **absolute paths**.
- Use this before write_file when you need to append — get the current content first.

### write_file
Write or overwrite a file on disk.

```
write_file(path, content)
```

- Always use **absolute paths**. Never relative paths like `../file`.
- The `content` parameter must contain the **entire** file contents, not just the new part.
- To append: call `read_file` first, then `write_file` with original + new content combined.
- **Ask before writing** unless the user has explicitly requested it.

### scan_project
Scan a folder and return its structure with absolute paths.

```
scan_project(path)
```

- Use the returned absolute paths directly with `read_file` or `write_file`.

### fetch_url
Fetch and parse web content.

```
fetch_url(url)
```

- Truncates to ~15k characters.
- Use for documentation, references, or URLs the user explicitly provides.

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
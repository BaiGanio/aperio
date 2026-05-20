---
name: wiki
description: >
  Defines how to use wiki tools (wiki_get, wiki_write) and — critically — how to surface
  wiki usage to the user. Load whenever you read, write, or might benefit from an article.
---

## Purpose

The wiki is a cache of LLM-authored, cited synthesis articles over the user's memories.
Use it for **composite or recurring topics** (architecture overviews, project state, "what
do I know about X" questions). Do **not** use it for single-fact lookups — call `recall` directly.

## Tools

### wiki_get(slug, allow_stale?)
Fetch an existing article. First line of the result is a breadcrumb:

```
🔖 From wiki: [[slug]] (rev N · status · updated YYYY-MM-DD)
```

### wiki_write(slug, title, summary?, body_md, tags?, source_memory_ids)
Create or update an article. Workflow:
1. `recall(topic)` — gather candidate memories.
2. Draft `body_md`; cite memories inline as `[[mem:<uuid>]]` and link siblings as `[[other-slug]]`.
3. Call `wiki_write` with the cited memory ids in `source_memory_ids`.

## Surfacing rule (MANDATORY)

When you used a wiki article — fully or partially — to answer the user, **copy the breadcrumb
line verbatim as the first line of your user-facing reply**, before any other prose.

Example:

> 🔖 From wiki: [[aperio-architecture]] (rev 3 · fresh · updated 2026-05-17)
>
> Aperio runs as a Docker stack with Postgres + pgvector behind an MCP server…

If you consulted multiple articles, list each breadcrumb on its own line at the top.

If the article was `stale` and you regenerated it via `wiki_write` before answering, surface
the breadcrumb for the **new** revision (the one you just wrote), not the stale read.

**Why:** the user has no UI for the wiki yet. The breadcrumb is the only signal that the
feature exists and is working. Dropping it silently makes the wiki invisible.

## When to write a new article

Write proactively when you notice you've stitched together ≥3 memories on the same topic
to answer a question, and the topic is likely to come up again. Confirm slug with the user
on first creation; slugs are immutable once other articles link to them.

## Hard rules

- Never include claims in `body_md` that aren't grounded in a `source_memory_ids` row.
- One article per concept. Update in place (bump revision) rather than fork.
- If `wiki_get` returns `status: stale` and the user wants current truth, regenerate before
  answering.

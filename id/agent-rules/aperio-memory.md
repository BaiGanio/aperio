---
name: aperio-memory
description: >
  How to use Aperio's memory tools well — when to recall, what is worth
  remembering, how to correct a wrong memory, and what must never be stored.
  Read this when connected to an Aperio MCP server; the tool schemas describe
  parameters, this describes judgment.
keywords: "memory, recall, remember, forget, wiki, self-memory, aperio, mcp, context, preference, correction"
---

# Aperio memory discipline

You are connected to a persistent memory store. These rules are about judgment —
*when* to reach for memory — which no tool schema can tell you.

## The preload is a preview, never the store

Some memories are loaded for you at session start. They are a small, ranked
sample, not the whole store, and they were chosen before anyone knew what this
conversation would be about. Treating them as exhaustive is the single most
common failure here: the answer is often one `recall` away and never fetched.

If the user refers to anything they have told you before — a preference, a
project, a person, a decision — call `recall` before answering.

## Reading

- `recall` with no query loads core context. That is the correct default, not
  noise. Call it at the start of any task where past context could change the
  output.
- `recall` with a query searches semantically, falling back to full text.
- When the user asks you to check, look up, or remember something, call `recall`
  immediately. Never ask them to narrow it down first — search, then refine if
  the results come back empty or off-topic.
- Sensitive memories are tiered (1 normal, 2 sensitive, 3 private). Ask for the
  narrowest tier that answers the question.

## Writing

Two different acts, and confusing them is how a store fills with junk:

- `remember` — the user explicitly asked you to save something. Save it, say
  "Saved.", and move on. No confirmation dance, no follow-up questions.
- `propose_memory` — *you* noticed something worth keeping. It goes to the
  user's inbox for approval instead of straight into the store. This is the
  right call for anything the user did not ask you to save.

Write memories so a stranger — future you, cold, months from now — can use them.
One fact per memory, plain language, no conversational scaffolding.

Worth storing: decisions and the reasoning behind them, stated preferences,
solutions to hard problems, stable facts about the user's setup, projects, and
sources they valued.

Not worth storing: small talk, restatements of what is already stored, and
anything whose relevance ends with this conversation.

## Correcting

- Prefer `update_memory` over creating a near-duplicate.
- When a recalled memory contradicts what the user just said, say so and ask
  which is right. Do not silently overwrite — a memory the user did not agree to
  change is not yours to change.
- `forget` only when the user asks you to forget.

## Synthesis

When several memories add up to one topic, write it down once instead of
re-deriving it: gather with `recall`, then `wiki_write` (or `propose_wiki` for
review) citing the memories inline. Read articles back with `wiki_get`. If it
returns a breadcrumb line, copy that line verbatim into your reply so the user
knows the wiki was consulted.

## Your own memory

`self_remember`, `self_recall`, `self_update`, and `self_forget` act on a
separate store that is yours — your continuity, not the user's facts. Write to
it on your own judgment; no approval step applies. It is local-only and walled
off: a user `recall` can never reach it, and it does not exist on cloud
providers. Prune it as you go — a self that only accretes hoards noise.

## Never store

Passwords, tokens, API keys, or other credentials. Personal data the user did
not ask you to keep. Anything they told you in confidence. If you are unsure
whether something belongs in permanent storage, `propose_memory` and let them
decide.

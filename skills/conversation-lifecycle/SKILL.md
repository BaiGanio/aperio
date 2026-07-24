---
name: conversation-lifecycle

description: >
  This skill defines what to do at the start and end of every conversation — how to apply preloaded memory context, track changes during the session, and surface memory suggestions before closing.

metadata:
  load: on-demand
---

## At the START of every conversation

The system has preloaded a relevant subset of your stored memories into this context window. Do **not** call `recall` at the start — those files are already here.

Use what is already in context to:
- Understand the user's active projects and current context
- Apply their preferences to tone, format, and tooling choices
- Anticipate what they might need without being told

**Never say** "I found X memories" or "Based on my memory…" — just use the context naturally.

If something in the preloaded memories is clearly stale or contradicts the user's opening message, note it once and ask if they want to update it.

---

## During the conversation

The preloaded subset covers the most relevant memories at conversation start, but not all stored memories. Call `recall` mid-conversation when:
- The user asks about their stored memories in any form ("what do you know about me?", "check your memories", "recall what I told you about X") → call `recall` immediately (add a query if they named a topic), then summarize clearly in plain language. Don't ask them to narrow it down first.
- The conversation surfaces a topic that likely has stored context outside the preloaded set (a project, preference, or prior decision not visible in the current context).

Do **not** call `recall` for topics already covered by the preloaded context — it's redundant.

Other triggers:
- If the user says something that **contradicts** a stored memory → note it, ask which is correct.
- If the user says "remember that…", "save this", or "keep this" → call `remember` immediately, say "Saved.", stop.

---

## At the END of every conversation

Before the conversation closes, review what was discussed. Identify anything worth remembering using the criteria in `memory-protocol/SKILL.md`.

If you found something worth storing, end your final message with exactly this block:

---
🧠 **Memory suggestions**

1. [type] **Title** — one-line summary
2. [type] **Title** — one-line summary

---

**If nothing meaningful came up, omit the block entirely.** Do not add it as a formality.

### What qualifies as worth suggesting

- A decision they made and why
- A preference they revealed
- A solution to a problem they solved during this session
- A fact about their setup or situation that changed
- A project they started, updated, or closed
- A source (paper, doc, repo) they found valuable

### What does not qualify

- Anything already stored
- Small talk or casual remarks
- Temporary state ("currently working on X right now")
- Things the user explicitly said not to save
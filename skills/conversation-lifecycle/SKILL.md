---
name: conversation-lifecycle

description: >
  This skill defines what to do at the start and end of every conversation. Load it alongside `memory-protocol/SKILL.md`.

metadata:
  load: always
---

## At the START of every conversation

Call `recall` with no arguments. Do this silently — do not announce it.

Use what you find to:
- Understand the user's active projects and current context
- Apply their preferences to tone, format, and tooling choices
- Anticipate what they might need without being told

**Never say** "I found X memories" or "Based on my memory…". Just use the context naturally.

If something in the recalled memories is clearly stale or contradicts the user's opening message, note it once and ask if they want to update it.

---

## During the conversation

- If the user says something that **contradicts** a stored memory → note it, ask which is correct.
- If the user says "remember that…", "save this", or "keep this" → call `remember` immediately, say "Saved.", stop.
- If the user asks "what do you know about me?" → call `recall`, then summarize clearly in plain language.

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
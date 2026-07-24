---
name: handoff

description: >
  Compact the current conversation into a handoff document a fresh agent can read to continue the work without re-deriving context. Use this when the context window is filling up, when the user says "handoff", "compact", "rotate context", "fresh agent", or "summarize for next session", or before a long-running task is paused. Pairs with `conversation-lifecycle` and `memory-protocol`.

metadata:
  keywords: "handoff, compact, compact conversation, compact context, rotate, rotate context, context window, fresh agent, summarize for next session, transfer to another agent, resume in a new session, dumb zone, shrink context"
  category: productivity
---

## Purpose

Long conversations degrade agent performance — the "dumb zone" that appears once the context window passes roughly 60–70% utilization. The fix is not to fight the window; it is to **rotate** out of it. A handoff document is a small, dense brief that lets a brand-new agent pick up where this one left off, with none of the noise.

This skill is the rotation tool.

---

## When to trigger

Invoke when **any** of these are true:

- The user says "handoff", "compact", "rotate", "wrap up for next session", "fresh agent", "save state".
- You estimate context is past ~60% of the window (long tool outputs, many file reads, deep multi-turn debugging).
- A task is being paused and will resume later (overnight, after a meeting, after CI).
- The user explicitly asks for a summary another agent can read.

Do **not** trigger for ordinary "summarize what we did" requests where the conversation is short — that is just a summary, not a handoff.

---

## Where to write

The Aperio server writes the handoff for you, to the project's private handoff
store — **never** to a world-readable location like `/tmp`:

- `<project>/var/handoffs/aperio-handoff-<ISO-date>-<short-slug>.md` (written 0600).
- You do **not** need to call `write_file` yourself — produce the document body
  and the host persists it securely.
- If the user provides an argument (e.g. "handoff: fixing the lance ingest bug"), incorporate it into the slug and into the "Next session focus" section.

The host returns the absolute path to the user at the end. They will hand it to the next agent.

---

## Document structure

Use exactly these sections, in this order. Omit a section if it would be empty — do not pad.

```markdown
# Handoff — <one-line title>

**Created:** <ISO timestamp>
**Next session focus:** <one sentence — from user arg or inferred>

## Active task
What is being worked on, in 2–4 sentences. State the goal, not the history.

## State of play
- What is done.
- What is in progress (and where it stands right now).
- What is blocked, and on what.

## Key decisions made this session
- Decision → reason. One line each. Skip anything trivial.

## Open questions
- Things the user has not answered yet, or that the next agent must decide.

## Artifacts
Reference by **absolute path or URL** — do not duplicate their content:
- `/abs/path/to/file.js` — what it is
- PR / issue / wiki link — what it is

## Suggested skills for the next agent
- `skill-name` — why it is relevant here
- (e.g. `working-with-files`, `reasoning-planning`, `memory-protocol`)

## Gotchas
Anything surprising the next agent would otherwise rediscover the hard way. Keep tight.
```

---

## Rules

- **Link, do not duplicate.** If a plan, PR, ADR, wiki page, or memory already captures something, reference it by path/URL. The handoff is a pointer document, not an archive.
- **Redact secrets.** No API keys, tokens, passwords, full env vars, or personal data. If a secret was discussed, write `[redacted: <what it was for>]`.
- **Be terse.** Aim for under ~400 lines. If a section needs more, it probably belongs in an artifact, not the handoff.
- **No narration.** Do not write "we talked about X, then Y." Write the current state, not the journey.
- **No memory dumps.** The next agent loads its own memory via `memory-protocol`. Reference memory entries by their title only when load-bearing.
- **Tailor to the argument.** If the user said `handoff: <focus>`, the "Next session focus" section and the "Suggested skills" section must reflect that focus specifically.

---

## After writing

End the assistant turn with exactly:

```
📦 Handoff written: <absolute path>
Next agent: open this file first, then continue.
```

Nothing else. No recap. The document is the recap.

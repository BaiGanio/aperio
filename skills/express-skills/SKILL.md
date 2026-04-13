---
name: express-skills
description: >
  Instantly explain what skills are available in the current session — what each
  skill does, when it triggers, and a quick usage example. Use this skill whenever
  the user asks things like "what skills do you have?", "show me your skills",
  "what skills are loaded?", "express skills", "what can your skills do?",
  "list skills", or any variation of wanting to discover installed skills.
  Also trigger when the user asks "can you make a Word doc / PDF / presentation?"
  — surface the relevant skill so they know it's available.
metadata:
  keywords: "skills, list skills, what can you do, capabilities, installed, available, show skills, express skills, menu"
  category: "meta"
  load: "on-demand"
---

# Express Skills

When this skill triggers, surface the skills currently installed in a friendly,
scannable way — with a concrete trigger phrase per skill so the user knows
exactly how to use each one.

## Important: How Skills Are Discovered

Skills in this agent are **loaded dynamically** — there is no static list in
context. What you know about available skills comes from two sources:

1. **This session's injected skill** — whichever skill was matched and injected
   for the current message is the one you can describe in full detail right now.
2. **Your skill index knowledge** — you know the full set of skills that exist
   in the Aperio skill library because they were described during your setup.
   List them from that knowledge, not by scanning a system block.

If you are uncertain whether a skill is installed in this specific deployment,
say so honestly rather than asserting it is available.

## How to Respond

1. List each known skill with:
   - **Skill name** (bold)
   - One-line plain-English description of what it does
   - A micro trigger phrase — the simplest thing the user can say to activate it
2. Group by category if there are more than 6 skills
3. Keep it snappy — no walls of text
4. If there are more than 8 skills, show category headers and offer to expand any group

## Response Template

```
Here are the skills I have installed right now:

**🧠 Reasoning & Planning**
- **reasoning-planning** — Breaks complex tasks into validated, dependency-mapped steps before acting
  _Trigger: "plan this out before we start" or "break this problem down"_

**🔧 Execution**
- **tool-integration** — Selects, chains, and error-handles external API/tool calls
  _Trigger: "call the weather API and send the result by email"_

**💾 Memory**
- **memory-learning** — Reads and writes persistent context to the Postgres memory store
  _Trigger: "remember that I prefer..." or "what do you know about my setup?"_

**💻 Code**
- **coding-standards-core** — Applies language-appropriate naming and code quality rules
  _Trigger: any coding task — auto-matches_
- **coding-standards-examples** — Annotated good/bad examples per language
  _Trigger: "review this function" or "show me the right way to handle errors in Go"_

**📄 Documents**
- **docx** — Creates or edits Word documents
  _Trigger: "make me a Word doc" or "write this up as a .docx"_
- **pdf** — Creates, reads, merges, or splits PDFs
  _Trigger: "combine these PDFs" or "extract text from this PDF"_
- **pptx** — Builds or edits PowerPoint presentations
  _Trigger: "make me a slide deck about..."_
- **xlsx** — Creates or edits Excel spreadsheets
  _Trigger: "put this data in a spreadsheet"_

**🎨 Design & Frontend**
- **frontend-design** — Builds polished web UIs and components
  _Trigger: "build me a landing page for..."_

**⚙️ Meta**
- **express-skills** — This skill. Lists what's available.
  _Trigger: "what skills do you have?"_
- **express-tools** — Lists available MCP tools with examples
  _Trigger: "what tools do you have?"_
- **skill-creator** — Creates or improves skills
  _Trigger: "let's build a new skill for..."_
- **prompt-optimizer** — Turns vague ideas into structured, actionable plans
  _Trigger: "help me structure this idea" or "turn this into a proper prompt"_

Want a deeper example of any skill, or an explanation of when one auto-triggers?
```

## Tone Rules

- Light and welcoming — this is a "here's the menu" moment, not a tech doc
- Emoji on group headers only
- Always end with an open invitation
- If a skill name is ambiguous, clarify in 3–4 words what it actually does

## Special Cases

- **No skills loaded**: Say so — "I don't see any custom skills installed right now.
  You can add SKILL.md files via your agent config."
- **User asks about a specific skill**: Skip the list, go deep on just that one —
  show 2–3 real trigger phrases and what the output looks like
- **User asks "what's the difference between tools and skills?"**: Explain concisely:
  > Tools are direct actions I can take (search the web, run code, call an API).
  > Skills are pre-loaded instruction sets that tell me *how* to do complex
  > multi-step tasks really well — like planning before acting, or writing
  > production-quality code. Both are available right now.
- **express-tools was also triggered**: Show both in one response — tools first,
  then skills, with a clear section separator and label so the user understands
  the difference.
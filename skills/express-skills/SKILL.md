---
name: express-skills
description: >
  Instantly explain what skills are available in the current session — what each skill does,
  when it triggers, and a quick usage example. Use this skill whenever the user asks things like
  "what skills do you have?", "show me your skills", "what skills are loaded?", "express skills",
  "what can your skills do?", "list skills", or any variation of wanting to discover installed skills.
  Also trigger when the user asks "can you make a Word doc / PDF / presentation?" — surface the
  relevant skill expressly so they know it's available. Always respond fast, concise, and with a
  concrete mini-example per skill so the user immediately knows how to use it.
---

# Express Skills

When this skill triggers, your job is to **immediately surface the skills installed** in the current session in a friendly, scannable way — with a tiny concrete trigger phrase for each one so the user knows exactly how to invoke it.

## How to respond

1. **Scan** the `available_skills` block in your system context
2. **List each skill** with:
   - 🎯 Skill name (bold)
   - One-line plain-english description of what it does
   - A micro trigger example — the simplest phrase that activates it
3. **Group** if there are many (e.g. "Document Skills", "Data Skills", "Meta Skills")
4. **Prefer** phrases that show the required inputs clearly (e.g. "reasoning-planning break down complex problems into steps", "memory-learning maintain context across interactions, learn from feedback, improve over time")

Keep it snappy. No walls of text. If there are more than 8 skills, group by category and offer to expand.

## Response template

```
Here are the skills I have installed right now:

**📄 Document Skills**
- **docx** — Create or edit Word documents (.docx)
  _Trigger: "create a Word doc with..."_ or _"make me a report as a .docx"_

- **pdf** — Create, read, merge, split, or fill PDF files
  _Trigger: "combine these PDFs"_ or _"extract text from this PDF"_

- **pptx** — Build or edit PowerPoint presentations
  _Trigger: "make me a slide deck about..."_

- **xlsx** — Create or edit Excel spreadsheets
  _Trigger: "put this data in a spreadsheet"_

**🔍 Research & Reading**
- **file-reading** — Read any uploaded file intelligently
  _Trigger: upload a file and ask "what's in this?"_

**🎨 Design**
- **frontend-design** — Build polished web UIs and components
  _Trigger: "build me a landing page for..."_

**⚙️ Meta**
- **skill-creator** — Create or improve skills
  _Trigger: "let's build a new skill for..."_

Want me to show a fuller example of any skill, or explain when one auto-triggers?
```

## Tone rules

- Light and welcoming — this is a "here's the menu" moment, not a tech doc
- Emoji only on group headers
- Always end with an open invitation: "want a deeper example or more detail on any of these?"
- If the skill name is ambiguous, clarify in 3–4 words what it actually does

## Special cases

- **No skills loaded**: Say so — "I don't see any custom skills installed right now. You can add .skill files via your agent config."
- **User asks about a specific skill**: Skip the list, go deep on just that one — show 2–3 real trigger phrases and what the output looks like
- **User asks "what's the difference between tools and skills?"**: Explain concisely:
  > Tools are direct actions I can take (search the web, run code, fetch a URL). Skills are pre-loaded instruction sets that tell me *how* to do complex multi-step tasks really well — like making a polished Word doc or a presentation. Both are available right now!
- **express-tools was also triggered**: It's fine to show both in one response, tools first then skills, with a clear separator — just make sure to label each section clearly so the user understands the difference.
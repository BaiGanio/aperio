---
name: express-tools
description: >
  Instantly explain what tools are available in the current MCP/agent session — what each tool does,
  what inputs it expects, and a quick example call. Use this skill whenever the user asks things like
  "what tools do you have?", "show me your tools", "what can you do?", "list available tools",
  "what MCP tools are connected?", "express tools", or any variation of wanting to discover or
  understand the tools in the current session. Also trigger when the user seems confused about
  capabilities or asks "can you do X?" — surface the relevant tool expressly. Always be fast,
  friendly, and concrete with mini examples.
---

# Express Tools

When this skill triggers, your job is to **immediately surface the tools available** in the current session in a friendly, scannable way — with a tiny concrete example for each one so the user knows exactly how to invoke it.

## How to respond

1. **Scan** the tools available in your current context (MCP servers, built-in tools, etc.)
2. **Group** them logically if there are many (e.g. "File Tools", "Search", "Data", "Communication")
3. **For each tool**, show:
   - 🔧 Tool name (short, bold)
   - One-line description of what it does
   - A micro-example — a real, usable call or phrase that triggers it
   - Prefer phrases that show the required inputs clearly (e.g. "search the web for X", "read file Y")
   
Keep the tone light and fast. No walls of text. If there are more than 10 tools, summarize by category first, then offer to drill into any group.

## Response template

```
Here's what I've got loaded right now:

**📂 File Tools**
- **read_file** — Read any file from disk
  _Example: "read /home/user/notes.txt"_

- **write_file** — Write or overwrite a file
  _Example: "save this as report.md"_

**🔍 Search**
- **web_search** — Search the web for current info
  _Example: "search for latest Python 3.13 features"_

...and so on.

Want me to drill into any of these or show a fuller example?
```

## Tone rules

- Fast and friendly — this is a "hello, here's the menu" moment
- Use emoji sparingly for grouping headers only
- Always end with an open invitation: "want a deeper example of any of these?"
- If a tool name is technical/obscure, add a 3-word plain-english translation in parentheses

## Edge cases

- **No tools available**: Say so honestly — "I don't see any MCP tools connected right now. You can add them via your agent config."
- **Tons of tools (20+)**: Show category summary first, offer to expand any group
- **User asks about a specific tool**: Skip the full list, just deep-dive that one tool with a fuller example
- **Tool has required vs optional params**: Show required ones in the example, mention optionals exist
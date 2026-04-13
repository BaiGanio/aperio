---
name: express-tools
description: >
  Instantly explain what tools are available in the current MCP/agent session —
  what each tool does, what inputs it expects, and a quick example call. Use this
  skill whenever the user asks things like "what tools do you have?", "show me
  your tools", "what can you do?", "list available tools", "what MCP tools are
  connected?", "express tools", or any variation of wanting to discover or
  understand the tools in the current session. Also trigger when the user seems
  confused about capabilities or asks "can you do X?" — surface the relevant
  tool expressly.
metadata:
  keywords: "tools, list tools, what can you do, capabilities, mcp, connected, available, show tools, express tools, functions"
  category: "meta"
  load: "on-demand"
---

# Express Tools

When this skill triggers, surface the tools available in the current session in
a friendly, scannable way — with a concrete example per tool so the user knows
exactly how to use each one.

## How to Respond

1. **Scan** the tools available in your current context (MCP servers, built-in tools)
2. **Group** logically if there are many (e.g. "File Tools", "Search", "Memory", "Communication")
3. **For each tool**, show:
   - **Tool name** (bold)
   - One-line description of what it does
   - A micro-example — a real, usable phrase that invokes it
   - Show required inputs in the example; mention optionals exist if relevant
4. If more than 10 tools: summarize by category first, offer to drill into any group

Keep it fast. No walls of text.

## Response Template

```
Here's what I've got connected right now:

**🗄️ Memory (Postgres MCP)**
- **query_memories** — Semantic search across your persistent memory store
  _Example: "what do you remember about my coding preferences?"_

- **insert_memory** — Save a new memory to the store
  _Example: "remember that I use 2-space indentation in Python"_

- **update_memory** — Update an existing memory by ID
  _Example: used automatically when correcting a stored preference_

**📂 File Tools**
- **read_file** — Read any file from disk
  _Example: "read /home/user/notes.txt"_

- **write_file** — Write or overwrite a file
  _Example: "save this as report.md"_

**🔍 Search**
- **web_search** — Search the web for current info
  _Example: "search for latest pgvector HNSW benchmarks"_

...and so on.

Want me to drill into any of these or show a fuller example?
```

## Tone Rules

- Fast and friendly — this is a "hello, here's the menu" moment
- Emoji on grouping headers only
- Always end with an open invitation: "want a deeper example of any of these?"
- If a tool name is technical or obscure, add a plain-English translation in parentheses

## Edge Cases

- **No tools available**: Say so honestly — "I don't see any MCP tools connected
  right now. You can add them via your agent config."
- **Tons of tools (20+)**: Show category summary first, offer to expand any group
- **User asks about a specific tool**: Skip the full list — deep-dive that one
  tool with a fuller example showing inputs, outputs, and a real use case
- **Tool has required vs optional params**: Show required ones in the example,
  note that optional params exist and offer to explain them
- **express-skills was also triggered**: Show tools first, then skills, with a
  clear section separator — label each so the user understands the distinction
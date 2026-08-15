---
title: "Connecting Aperio to your world"
subtitle: "Give Claude, Codex, or another AI tool you already use the same memory Aperio built for you."
author: "Aperio maintainers"
lang: en
date: "2026-08-15"
description: "Connect Claude Desktop, Claude Code, Codex, or another MCP-compatible tool to Aperio's memory."
eyebrow: "Topic 4 of 6"
mascot: "../../../../docs/assets/mascot/robot-aurora-1024.png"
mascotcaption: "The same memory that answers you inside Aperio can answer you inside Claude or Codex too."
routes:
  - num: "01"
    href: "claude-desktop"
    label: "Connect Claude Desktop"
    desc: "Edit one settings file, then restart"
  - num: "02"
    href: "cli-tools"
    label: "Connect from a terminal"
    desc: "One command for Claude Code or Codex"
  - num: "03"
    href: "prove"
    label: "Prove the connection"
    desc: "Ask the same question, somewhere new"
---

# <span class="kicker">Part 1</span> Connect Claude Desktop {#claude-desktop}

<p class="promise">After this page, Claude Desktop can see and use everything Aperio remembers about you.</p>

*Getting started* proved Aperio remembers things in its own chat. This page carries that same memory into an AI tool you already use. Once connected, ask Claude Desktop things it never learned from you directly:

<ul>
<li><em>"What's my Wi-Fi password?"</em> — the one you stored in Aperio, not Claude</li>
</ul>

<ol class="steps">
<li>Find your Aperio folder's exact path: run <code>pwd</code> in a terminal there (macOS/Linux), or check it in Explorer (Windows) — then add <code>mcp/index.js</code>.</li>
<li>In the system menu bar, open <strong>Claude</strong> → <strong>Settings</strong> → <strong>Developer</strong> → <strong>Edit Config</strong>, which opens or creates <code>claude_desktop_config.json</code>.</li>
<li>Paste this in, replacing the path with the one from step 1, and save the file:
<pre><code>{
  "mcpServers": {
    "aperio": {
      "command": "node",
      "args": ["/path/to/aperio/mcp/index.js"]
    }
  }
}</code></pre>
</li>
<li>Quit Claude Desktop completely and reopen it — a running window doesn't pick up the change, only a fresh start does.</li>
</ol>

<div class="done-check"><span class="label">Done looks like</span>Claude Desktop's tools list shows "aperio" as a connected server.</div>

<blockquote class="snag"><p><strong>Aperio doesn't show up as connected.</strong> Check the path points at <code>mcp/index.js</code> itself, not just the folder, and that you fully quit and reopened Claude Desktop, not just closed the window. An error mentioning <code>node</code> instead means Node.js isn't installed yet — run Aperio-lite's <strong>START</strong> once to fix that.</p></blockquote>

<div class="next-link"><span class="label">Next</span>Connect from a terminal</div>

# <span class="kicker">Part 2</span> Connect from a terminal {#cli-tools}

<p class="promise">After this page, Claude Code or Codex can reach the same memory too — one command, no file to edit by hand.</p>

If you already write code with Claude Code or Codex, you can hand them Aperio's memory the same way — so a coding session can, for example, recall a detail you only ever told Aperio's chat:

<ul>
<li><em>"What did I say about the staging database password?"</em></li>
<li><em>"Remember that this project's release always ships on a Friday."</em></li>
</ul>

<ol class="steps">
<li>Open a terminal.</li>
<li>Run the command for your tool, using the same <code>mcp/index.js</code> path from Part 1:
<pre><code># Claude Code
claude mcp add aperio -- node /path/to/aperio/mcp/index.js

# Codex
codex mcp add aperio -- node /path/to/aperio/mcp/index.js</code></pre>
</li>
<li>Start a new conversation in that tool — the connection applies from the next session on.</li>
</ol>

<div class="done-check"><span class="label">Done looks like</span>Running <code>claude mcp list</code> (or <code>codex mcp list</code>) shows "aperio" in the list.</div>

<blockquote class="snag"><p><strong>The <code>mcp</code> command isn't recognized.</strong> Update Claude Code or Codex to its latest version — MCP support needs a reasonably recent release.</p></blockquote>

<div class="next-link"><span class="label">Next</span>Prove the connection</div>

# <span class="kicker">Part 3</span> Prove the connection {#prove}

<p class="promise">After this page, you'll have real proof the same memory now follows you outside Aperio's own chat.</p>

This mirrors the proof from *Getting started* — only this time, ask somewhere new. Don't open Aperio's web app for this part at all.

<ol class="steps">
<li>Open Claude Desktop, Claude Code, or Codex — whichever you connected.</li>
<li>Start a new conversation there.</li>
<li>Ask the same question you proved in <em>Getting started</em>. Stored the Wi-Fi password? Ask: <em>"What's my Wi-Fi password?"</em> Stored the vet's number instead? Ask: <em>"What's the vet's phone number?"</em></li>
</ol>

<div class="done-check"><span class="label">Done looks like</span>The answer matches what you stored in Aperio — coming from a completely different tool, without you retyping it there.</div>

<blockquote class="snag"><p><strong>It says it doesn't have a way to check.</strong> Ask it to use the Aperio tool explicitly the first couple of times — for example, <em>"Use Aperio to recall my Wi-Fi password."</em> Most tools start calling it on their own after that.</p></blockquote>
<blockquote class="snag"><p><strong>It doesn't know, or answers something else entirely.</strong> Double-check the path in your config points at the very same Aperio folder you've been using — a different copy of Aperio keeps its own separate, empty memory.</p></blockquote>

You've now connected Aperio's memory to Claude Desktop, Claude Code, or Codex, and proven the same memory follows you into all of them. Want to run Aperio from source, on a server, or with a cloud AI provider instead of the ready-made download? That's covered in the *Setup & configuration* topic.

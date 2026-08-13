---
title: "Aperio owner manual"
subtitle: "One brain. Every agent. Nothing forgotten."
author: "Aperio maintainers"
lang: en
date: "Release 0.68"
description: "A standalone visual-system prototype for the Aperio owner manual."
keywords:
  - Aperio
  - manual
  - visual system
---

::: {.prototype-page .cover-page #welcome}
<div class="running-top"><span>Aperio owner manual</span><span class="signal-id">00 / tune in</span></div>

<div class="cover-grid">
<div class="cover-copy">
<p class="eyebrow">Owner manual / release 0.68</p>

# Make recall part of the path

Aperio gives every agent one durable, self-hosted memory. This manual gets you from first launch to verified recall, then stays beside you for operation, recovery, and contribution.

<div class="cover-actions" aria-label="Manual routes">
<a href="#first-recall">Start in 10 minutes</a>
<a href="#routes">Choose your route</a>
</div>
</div>

<figure class="cover-art">
<div class="aurora-window">
<img src="../../../docs/assets/mascot/robot-aurora-1024.png" alt="Aperio's small retro-radio robot, lit by violet, pink, and cyan aurora bands.">
</div>
<figcaption>Aperio listens for what matters, then helps the next conversation remember it.</figcaption>
</figure>
</div>

<nav class="route-panel" id="routes" aria-label="Reader routes">
<p class="route-label">Choose a frequency</p>
<ol>
<li><a href="#first-recall"><span>01</span><span class="strong">First recall</span><small>Install, connect, remember</small></a></li>
<li><a href="#platform-paths"><span>02</span><span class="strong">Operate</span><small>Configure, update, recover</small></a></li>
<li><a href="#reference"><span>03</span><span class="strong">Integrate</span><small>MCP, automation, internals</small></a></li>
</ol>
</nav>

<div class="running-bottom"><span>Read by task, topic, or role</span><span>aperio / manual</span></div>
:::

::: {.prototype-page .task-page #first-recall}
<div class="running-top"><span>Fast path / First recall</span><span class="signal-id">01 / receive</span></div>

<div class="chapter-head">
<p class="chapter-number">01</p>
<div>
<p class="eyebrow">10 minute fast path</p>

# Store one memory.<br>Recall it later.

This path proves the whole loop before you tune anything. You are done when a fresh conversation retrieves a detail that was not copied into its prompt.
</div>
</div>

> <span class="callout-label">Success / finish line.</span> A second conversation recalls the marina gate code after the first conversation has ended.

## 1. Keep the first setup local

Create `.env` with the smallest useful configuration:

```dotenv
AI_PROVIDER=llamacpp
DB_BACKEND=sqlite
EMBEDDING_PROVIDER=transformers
```

<div class="step-grid">
<section class="step-card">
<span class="step-dial">1</span>
<h3>Start Aperio</h3>
<p>Run the normal start command and wait for the connected state.</p>
<code>npm start</code>
</section>
<section class="step-card">
<span class="step-dial">2</span>
<h3>Connect an agent</h3>
<p>Add Aperio as an MCP server, then confirm its memory tools are visible.</p>
</section>
<section class="step-card">
<span class="step-dial">3</span>
<h3>Prove recall</h3>
<p>Store a harmless fact, end the chat, and ask a fresh chat for it.</p>
</section>
</div>

> <span class="callout-label">Caution / keep secrets off the air.</span> Test with a harmless fact. Do not store passwords, API keys, or recovery codes as a recall check.

<div class="recovery-strip"><span>Nothing came back?</span><a href="#troubleshoot">Check indexing</a><a href="#troubleshoot">Search exact text</a><a href="#troubleshoot">Inspect provider state</a></div>

<div class="running-bottom"><span>Next: connect the agent you use every day</span><span>2</span></div>
:::

::: {.prototype-page .platform-page #platform-paths}
<div class="running-top"><span>Operate / Platform paths</span><span class="signal-id">02 / align</span></div>

<div class="chapter-head compact">
<p class="chapter-number">02</p>
<div>
<p class="eyebrow">One task, labeled differences</p>

# Put the configuration<br>where Aperio reads it

The decision is shared across platforms; only the file path and service controls differ.
</div>
</div>

<div class="platform-lanes" role="group" aria-label="Platform-specific configuration paths">
<section class="platform-lane mac"><h2><span>macOS</span> Apple silicon and Intel</h2><p>Use the project `.env`, then allow Keychain access if database encryption is enabled.</p><code>cp .env.example .env</code></section>
<section class="platform-lane windows"><h2><span>Windows</span> PowerShell</h2><p>Use the same project file. Keep UTF-8 encoding and avoid a hidden `.txt` suffix.</p><code>Copy-Item .env.example .env</code></section>
<section class="platform-lane linux"><h2><span>Linux</span> Desktop or server</h2><p>Use the project file for an interactive install or the service environment for a daemon.</p><code>cp .env.example .env</code></section>
</div>

<figure class="screenshot-figure">
<div class="screenshot-frame"><span class="screen-label">Release-matched UI / illustrative facsimile</span><img src="assets/settings-screen.svg" alt="Aperio settings panel with Provider set to llama.cpp, Storage set to SQLite, and three numbered annotation pins."></div>
<figcaption><span class="caption-number">Figure 2.1</span> Use numbered pins only where the image removes ambiguity. The procedure remains complete without the screenshot.</figcaption>
</figure>

<ol class="annotation-key">
<li><span>1</span><p><span class="strong">Provider.</span> Choose where chat inference runs.</p></li>
<li><span>2</span><p><span class="strong">Storage.</span> SQLite is the zero-configuration default.</p></li>
<li><span>3</span><p><span class="strong">Source badge.</span> Confirm whether the value came from DB, environment, or default.</p></li>
</ol>

<div class="running-bottom"><span>Common intent; differences stay in their lane</span><span>3</span></div>
:::

::: {.prototype-page .reference-page #reference}
<div class="running-top"><span>Reference / Recall system</span><span class="signal-id">03 / trace</span></div>

<div class="chapter-head compact">
<p class="chapter-number">03</p>
<div>
<p class="eyebrow">Understand enough to recover</p>

# Follow a memory through<br>the receiver

Every layer has one job and one piece of evidence. Trace the signal in order; do not change thresholds until you know which layer failed.
</div>
</div>

<figure class="diagram-figure">
<img src="assets/recall-signal.svg" alt="A four-stage signal path: an agent sends a memory to Aperio, Aperio stores text and vectors, a later agent asks a related question, and ranked recall returns the memory.">
<figcaption><span class="caption-number">Figure 3.1</span> The recall path. Shape, labels, and numbering carry the meaning without relying on aurora color.</figcaption>
</figure>

| Layer | Owns | Evidence when healthy | First recovery move |
|:--|:--|:--|:--|
| Agent | Tool request and useful context | Memory tool returns a stable ID | Confirm the MCP connection |
| Aperio | Validation and durable write | Record exists with expected scope | Search a distinctive phrase |
| Embedder | Searchable vector representation | Queue reaches completed state | Inspect provider and queue state |
| Recall | Ranking and context delivery | Relevant memory enters the next turn | Compare exact and semantic search |

<div class="mascot-guide" role="note" aria-label="Selective mascot guidance example">
<img src="../../../docs/assets/mascot/head-64.webp" alt="">
<div><p class="guide-label">Aperio says</p><p><span class="strong">Trace before tuning.</span> If exact search works but semantic recall does not, the useful evidence is between storage and embedding - not in the ranking threshold.</p></div>
</div>

## Troubleshooting by symptom {#troubleshoot}

<div class="symptom-row"><span class="meter-mark">A</span><p><span class="strong">No tools appear</span><br>Check the MCP connection and server command.</p><span class="meter-mark">B</span><p><span class="strong">Exact search is empty</span><br>Check write acceptance, scope, and database state.</p><span class="meter-mark">C</span><p><span class="strong">Semantic recall is empty</span><br>Check the embedding provider and queue.</p></div>

<div class="running-bottom"><span>Evidence first. Tuning second.</span><span>4</span></div>
:::

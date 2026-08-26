---
title: "Setup & configuration"
subtitle: "Run Aperio from source, reach it from another device, or switch it to a cloud AI provider — when you want more than the ready-made download."
author: "Aperio maintainers"
lang: en
date: "2026-08-15"
description: "Install Aperio from source, run it on a server, and configure a cloud AI provider."
eyebrow: "Topic 5 of 6"
mascot: "../../../../docs/assets/mascot/robot-aurora-1024.png"
mascotcaption: "The same Aperio, running the way that fits you — on your laptop, on a server, with the AI of your choice."
routes:
  - num: "01"
    href: "install-source"
    label: "Install from source"
    desc: "For running on a server or customizing Aperio"
  - num: "02"
    href: "server"
    label: "Run it on a server"
    desc: "Reach Aperio from another device on your network"
  - num: "03"
    href: "cloud-provider"
    label: "Use a cloud AI provider"
    desc: "Swap the built-in local AI for one you already use"
---

# <span class="kicker">Part 1</span> Install from source {#install-source}

<p class="promise">After this page, Aperio runs from its own source code — the path to take if you plan to run it on a server or change how it works.</p>

*Getting started* used Aperio-lite, the ready-made download. That is the easiest way to try Aperio and it's enough for most people. This page is for a different situation: you want Aperio running unattended on a server, or you want to work with the code directly.

<ol class="steps">
<li>Install <a href="https://nodejs.org/en/download">Node.js 24 or newer</a>, if you don't already have it.</li>
<li>Open a terminal and get Aperio's code:
<pre><code>git clone --depth 1 -b dev https://github.com/BaiGanio/aperio.git
cd aperio</code></pre>
</li>
<li>Install and start Aperio:
<pre><code>npm install
npm run start:local</code></pre>
</li>
<li>Open <code>http://localhost:31337</code> in your browser once the terminal says it's ready.</li>
</ol>

<div class="done-check"><span class="label">Done looks like</span>The same welcome screen from <em>Getting started</em> opens, with no red error banner. The first time, Aperio again downloads its local AI engine and model — that only happens once.</div>

<blockquote class="snag"><p><strong>A command isn't recognized.</strong> Reinstall Node.js from nodejs.org — it also installs <code>npm</code>. On Windows, install <a href="https://git-scm.com/downloads">Git</a> separately if <code>git</code> isn't found; macOS and Linux usually already have it.</p></blockquote>

<div class="note-box"><span class="label">Worth knowing</span>Both installs are the same Aperio — Aperio-lite is just this same source code, packaged with the setup steps done for you.</div>

<div class="next-link"><span class="label">Next</span>Run it on a server</div>

# <span class="kicker">Part 2</span> Run it on a server {#server}

<p class="promise">After this page, you can open Aperio from another device on your home network — not just the computer it runs on.</p>

By default, Aperio only answers your own computer, for safety. Opening it up to your network is useful if you want to reach it from your phone, or from another computer in the house, without installing it there too.

<ol class="steps">
<li>Find the computer's address on your network: on macOS, System Settings → Wi-Fi → Details; on Windows, run <code>ipconfig</code> in a terminal; on Linux, run <code>hostname -I</code>. It looks like <code>192.168.1.42</code>.</li>
<li>In the Aperio folder, copy the example settings file if you don't already have one: <code>cp .env.example .env</code>.</li>
<li>Open <code>.env</code> in a text editor and add these two lines, using your own address from step 1:
<pre><code>HOST=0.0.0.0
APERIO_ALLOWED_HOSTS=192.168.1.42</code></pre>
</li>
<li>Restart Aperio: stop it (close the START window, or <code>Ctrl+C</code> in its terminal) and start it again.</li>
<li>On another device connected to the <strong>same network</strong>, open <code>http://192.168.1.42:31337</code> in a browser, using your own address and port.</li>
</ol>

<div class="done-check"><span class="label">Done looks like</span>Aperio's web app opens on the other device, showing the same memories as on the computer it runs on.</div>

<blockquote class="snag"><p><strong>The other device says "host not allowed."</strong> The address in your browser must exactly match the one you put in <code>APERIO_ALLOWED_HOSTS</code> — home Wi-Fi sometimes changes a computer's address, so re-check it with step 1 and update <code>.env</code> if it moved.</p></blockquote>

<div class="note-box"><span class="label">Worth knowing</span>Only do this on a network you trust, such as your home Wi-Fi. Setting <code>HOST=0.0.0.0</code> makes Aperio reachable to every device on that network, not just yours — never do it on a public or shared Wi-Fi network.</div>

<div class="next-link"><span class="label">Next</span>Use a cloud AI provider</div>

# <span class="kicker">Part 3</span> Use a cloud AI provider {#cloud-provider}

<p class="promise">After this page, Aperio can think with an AI service you already use — such as Claude or Gemini — instead of its free, built-in local AI.</p>

Aperio's built-in AI runs entirely on your own computer, for free and in private. A cloud provider can be worth switching to if you already pay for one and want its answers instead — your memories stay exactly the same either way, only which AI does the thinking changes.

<ol class="steps">
<li>Get an API key from the provider you want, from their own website — for example <a href="https://console.anthropic.com">console.anthropic.com</a> for Claude, or <a href="https://aistudio.google.com">aistudio.google.com</a> for Gemini.</li>
<li>In Aperio, open the sidebar and click <strong>Config</strong>.</li>
<li>Search for <em>AI Provider</em>, choose your provider from the list, then paste your API key into the matching field just below it.</li>
<li>Close the panel, then restart Aperio for the change to take effect.</li>
</ol>

<div class="done-check"><span class="label">Done looks like</span>Ask the same question you proved earlier — the Wi-Fi password or vet's phone number from <em>Getting started</em>. It answers correctly, now thinking with the new provider, because Aperio's memory didn't change.</div>

<blockquote class="snag"><p><strong>Aperio says the key is invalid or won't connect.</strong> Re-copy the key from the provider's website, checking for extra spaces, and confirm it's active there — a new key can take a minute to activate.</p></blockquote>

<div class="note-box"><span class="label">Worth knowing</span>Cloud providers bill for use on their own site — check their pricing before switching. The built-in local AI stays free and fully private, since nothing leaves your computer.</div>

You've now set up Aperio your way — from source if you needed it, reachable on your network, and thinking with whichever AI you choose. The *Privacy & upkeep* topic covers keeping your data safe and Aperio running smoothly over time.

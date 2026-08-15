---
title: "Getting started"
subtitle: "Install Aperio, chat with it, and prove it remembers — about ten minutes, start to finish."
author: "Aperio maintainers"
lang: en
date: "2026-08-15"
description: "Install Aperio, store your first memory, and prove recall works."
eyebrow: "Topic 1 of 6"
mascot: "../../../../docs/assets/mascot/robot-aurora-1024.png"
mascotcaption: "Aperio listens for what matters, then helps the next conversation remember it."
routes:
  - num: "01"
    href: "install"
    label: "Install Aperio"
    desc: "Download, unzip, double-click START"
  - num: "02"
    href: "chat"
    label: "Chat and remember"
    desc: "Store your first memory, right in Aperio"
  - num: "03"
    href: "recall"
    label: "Prove it recalls"
    desc: "A new conversation, same memory"
---

# <span class="kicker">Part 1</span> Install Aperio {#install}

<p class="promise">After this page, Aperio is running on your computer and open in your browser.</p>

Right now, when you close a chat with an AI assistant, it forgets everything. Aperio gives you an AI with a memory that survives — even in a brand new conversation. Installing it takes about five minutes.

<ol class="steps">
<li>Go to the Aperio releases page and download <strong>Aperio-lite</strong>.</li>
<li>Unzip the file you downloaded.</li>
<li>Open the unzipped folder and double-click <strong>START</strong>.</li>
<li>Wait — a browser tab should open by itself at a local address on your own computer.</li>
<li>First time only: Aperio downloads a small AI engine and model to run locally. Keep your computer online and awake until it finishes — a few minutes.</li>
</ol>

<div class="done-check"><span class="label">Done looks like</span>The Aperio web app is open in your browser, showing a welcome screen with no red error banner.</div>

<blockquote class="snag"><p><strong>Nothing opened by itself.</strong> Open your browser and go to <code>http://localhost:31337</code> yourself.</p></blockquote>
<blockquote class="snag"><p><strong>The first-time download is slow.</strong> That's normal on a slower connection. It only happens once — after that, Aperio starts in seconds.</p></blockquote>

<div class="note-box"><span class="label">Worth knowing</span><ul>
<li>Aperio lives in the folder you unzipped — nothing else was installed on your computer.</li>
<li>To stop or restart it, close or reopen that window, or double-click START again.</li>
</ul></div>

If you'd rather install from the source code instead of using the ready-made download — for example, to run Aperio on a server — that longer path lives in the *Setup & configuration* topic, not here.

<div class="next-link"><span class="label">Next</span>Chat and remember</div>

# <span class="kicker">Part 2</span> Chat and remember {#chat}

<p class="promise">After this page, Aperio has remembered one thing you told it — no extra apps or setup needed.</p>

Aperio isn't just a memory store you plug other tools into — it's also its own AI you can talk to directly, right in the web app you just opened. That's the fastest way to see it work, before connecting anything else. It works for any small fact you don't want to repeat — a coffee order, a Wi-Fi password, a phone number:

<ul>
<li><em>"Remember that my favorite coffee order is a flat white with oat milk."</em></li>
<li><em>"Remember my Wi-Fi password: sunflower42."</em></li>
<li><em>"Remember the vet's phone number: 555-0142."</em></li>
</ul>

<ol class="steps">
<li>In the Aperio web app, open the chat panel.</li>
<li>Tell it something small, harmless, and specific — pick one of the examples above, or your own.</li>
<li>Wait for it to confirm.</li>
</ol>

<div class="done-check"><span class="label">Done looks like</span>Aperio confirms it saved what you told it. You can also see it appear in the web app's memory list.</div>

<blockquote class="snag"><p><strong>I don't see a memory list or chat panel.</strong> Look for it in the main navigation of the web app — it's the same page Aperio opened after install.</p></blockquote>

<div class="next-link"><span class="label">Next</span>Prove it recalls</div>

# <span class="kicker">Part 3</span> Prove it recalls {#recall}

<p class="promise">After this page, you'll have real proof Aperio works — a memory that survives into a brand new conversation.</p>

Close the conversation from Part 2 completely. Start a new one. Ask a related question without repeating the original information. A working memory answers correctly on its own.

<ol class="steps">
<li>Start a completely new conversation in Aperio.</li>
<li>Ask a related question without repeating what you told it. Picked the coffee order in Part 2? Ask: <em>"What's my usual coffee order?"</em> Picked the Wi-Fi password instead? Ask: <em>"What's my Wi-Fi password?"</em></li>
<li>Compare the answer to what you stored in Part 2.</li>
</ol>

<div class="done-check"><span class="label">Done looks like</span>The new conversation answers correctly, using only what Aperio remembered — you didn't repeat the original information.</div>

<blockquote class="snag"><p><strong>It doesn't recall anything.</strong> Open the web app's memory list to confirm the memory was actually stored in Part 2.</p></blockquote>
<blockquote class="snag"><p><strong>It remembers the wrong thing.</strong> Memories can be edited or removed from the same memory list.</p></blockquote>

You've now installed Aperio, talked to it, and proven recall works — all inside Aperio itself. Want that same memory available inside Claude, Codex, or another AI tool you already use? That's a separate step, covered in the *Connecting Aperio to your world* topic. The *Everyday memory* topic goes further on organizing memories and what Aperio tracks day to day.

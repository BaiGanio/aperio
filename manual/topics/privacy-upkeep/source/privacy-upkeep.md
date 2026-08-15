---
title: "Privacy, safety & upkeep"
subtitle: "Decide what stays extra private, back up everything Aperio remembers, and bring it back after a reinstall or a new computer."
author: "Aperio maintainers"
lang: en
date: "2026-08-15"
description: "Mark memories private, back up your data, and restore it later."
eyebrow: "Topic 6 of 6"
mascot: "../../../../docs/assets/mascot/robot-aurora-1024.png"
mascotcaption: "Your memories are yours — this topic keeps them private, and keeps them safe."
routes:
  - num: "01"
    href: "keep-private"
    label: "Keep something extra private"
    desc: "Tell Aperio a memory should never leave this computer"
  - num: "02"
    href: "backup"
    label: "Back up your memories"
    desc: "One plain file, in your own home folder"
  - num: "03"
    href: "restore"
    label: "Restore a backup"
    desc: "Bring memories back on a new computer"
---

# <span class="kicker">Part 1</span> Keep something extra private {#keep-private}

<p class="promise">After this page, you can tell Aperio to keep a specific memory on this computer only — even if you later switch to a cloud AI provider.</p>

Everything you tell Aperio already stays on your own computer by default, thinking with its free built-in local AI (see *Setup & configuration*). For most memories, that's already private enough. For a few — a password, a medical note, anything you'd never want to leave this machine even if you later connect a cloud AI — you can say so directly, and Aperio remembers that too:

<ul>
<li><em>"Remember my safe's combination, and keep it private — never send it to a cloud AI."</em></li>
<li><em>"Save this privately: my therapist's name is Dr. Okafor."</em></li>
<li><em>"Remember my passport number. Keep it off any AI service outside this computer."</em></li>
</ul>

<ol class="steps">
<li>In a chat with Aperio, say what you want it to remember.</li>
<li>Say plainly that it should stay private — for example, "keep it off any cloud AI."</li>
<li>Wait for Aperio to confirm.</li>
</ol>

<div class="done-check"><span class="label">Done looks like</span>Aperio confirms it saved the memory as private. Ask it later, <em>"is that memory private?"</em> — it checks and tells you.</div>

<blockquote class="snag"><p><strong>I'm not sure it worked.</strong> Say it as its own plain instruction — "remember this, and keep it private" — rather than burying "private" in the middle of a longer sentence, so Aperio doesn't miss it.</p></blockquote>

<div class="note-box"><span class="label">Worth knowing</span>While you're on Aperio's built-in local AI, every memory already stays on your computer — private or not. This setting only starts to matter once you connect a cloud AI provider: from then on, memories marked private are skipped for that provider, no matter what you ask it.</div>

<div class="next-link"><span class="label">Next</span>Back up your memories</div>

# <span class="kicker">Part 2</span> Back up your memories {#backup}

<p class="promise">After this page, everything Aperio remembers exists as one plain file you can keep somewhere safe.</p>

Aperio's memory lives in one file on your computer. Back it up before you reinstall Aperio or move to a new computer — the same way you'd back up a folder of photos or documents.

<ol class="steps">
<li>In a chat with Aperio, say: <em>"Back up all my memories."</em></li>
<li>Wait for Aperio to confirm.</li>
<li>Note the file name it gives you — by default, it's saved to your own home folder.</li>
</ol>

<div class="done-check"><span class="label">Done looks like</span>Aperio's reply names a file like <code>aperio-export-2026-08-15T12-00-00.json</code>, and that file exists in your home folder. Copy it somewhere safe — a backup drive, or cloud storage you trust.</div>

<blockquote class="snag"><p><strong>I can't find the file.</strong> It's saved in your own user folder — on macOS/Linux that's the one a new terminal opens in; on Windows, it's your own user folder, inside the Users folder on your <code>C:</code> drive. Search your file browser for "aperio-export" if you're still not sure.</p></blockquote>

<div class="note-box"><span class="label">Worth knowing</span>Uninstalling Aperio removes its memory database along with everything else it installed. Back up first if you plan to uninstall, reinstall, or move to a new computer.</div>

<div class="next-link"><span class="label">Next</span>Restore a backup</div>

# <span class="kicker">Part 3</span> Restore a backup {#restore}

<p class="promise">After this page, a backup file brings every memory back — on the same computer or a new one.</p>

Reinstalled Aperio, or set it up on a different computer? Point it at your backup file and everything comes back.

<ol class="steps">
<li>Copy your backup file onto the new or reinstalled computer, if it isn't there already.</li>
<li>In a chat with Aperio, say: <em>"Restore my memories from</em> <code>aperio-export-2026-08-15T12-00-00.json</code><em>"</em> — using your own file's name and location.</li>
<li>Wait for Aperio to confirm how many memories and articles came back.</li>
</ol>

<div class="done-check"><span class="label">Done looks like</span>Aperio reports the number of memories restored. Search for something you know was in the backup, the same way you would in <em>Everyday memory</em> — it should be there.</div>

<blockquote class="snag"><p><strong>A restored memory doesn't turn up in search yet.</strong> Aperio finishes making restored memories searchable in the background — wait a few minutes and search again.</p></blockquote>

<div class="note-box"><span class="label">Worth knowing</span>Restoring is safe to run more than once — Aperio matches memories and wiki pages by their own ID, so nothing gets duplicated.</div>

You've now marked what should stay private, backed up everything Aperio remembers, and proven you can bring it back. However you use Aperio from here, your memories are yours to keep — and now, yours to protect.

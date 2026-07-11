# Aperio-lite — How to Install & Use
> *One brain. Every agent. Nothing forgotten.*

Aperio runs **entirely on your own computer**.
**No cloud. No subscriptions. No data leaving your machine** (unless you choose a
cloud AI provider yourself during setup).

---

## Before You Start

| Requirement | Details |
|-------------|---------|
| **Operating system** | macOS, Linux, or Windows |
| **Internet** | Needed only during first-time setup — to fetch the AI engine, a model, and dependencies |
| **Offline?** | Everything works offline after setup. Only `fetch_url` / web search need the internet |
| **Disk space** | 3–20 GB free, depending on the AI model chosen for your machine |
| **RAM** | 4 GB minimum — more RAM lets the wizard pick a smarter model automatically |

> **No technical knowledge required.** A launcher gets Aperio running, then a
> friendly setup page in your browser does the rest. First-time setup takes
> **5–15 minutes**, mostly model download time.

- 📦 **Download the latest release:** [aperio-lite.zip](https://github.com/BaiGanio/aperio/releases/latest/download/aperio-lite.zip)
- 💬 **Questions & support:** [GitHub Discussions](https://github.com/BaiGanio/aperio/discussions/14)

Unzip `aperio-lite.zip` anywhere (your Desktop or Documents folder is fine). The
folder that comes out is *the app* — everything Aperio installs lives inside it.

---

## How to Run — First Time

You start Aperio with a small launcher. It does only the things a browser can't:
make sure **Node.js** and the app's **dependencies** are present, then start
Aperio's engine. Everything else — the AI engine (llama.cpp), the model, the
database, and any provider/API key — happens in the browser wizard the launcher
opens for you.

### 🪟 Windows

1. Open the Aperio folder.
2. Double-click **`START.bat`**.
3. If Windows shows a *"Windows protected your PC"* / *"Unknown publisher"*
   warning, click **More info → Run anyway** (expected for unsigned apps).
4. A window opens and gets things ready, then your browser opens to the setup
   page. Follow it.

The launcher also drops an **"Aperio" icon on your Desktop** — after the first
run, just double-click that (it starts Aperio with no console window).

### 🍎 macOS / 🐧 Linux

1. Open a terminal in the Aperio folder.
2. Run:
   ```bash
   bash START.sh
   ```
3. It checks Node.js and dependencies, then starts Aperio and opens your browser
   to the setup page.

The launcher drops an **"Aperio" launcher on your Desktop** for next time.

> **Keep the launcher window open** while you use Aperio — it *is* the engine.
> Closing it stops the app. (You can also stop Aperio from the **Quit** button
> in the app, or it shuts itself down after the browser tab is closed a while.)

If your browser doesn't open on its own, go to **http://localhost:31337**.

---

## What the Browser Setup Does

The setup page (the wizard) walks you through it — no config files to edit.

1. **Choose how the AI runs**
   - **Run locally — free & private** (recommended): nothing leaves your machine.
   - **Use a cloud AI**: paste one API key (Anthropic, DeepSeek, or Gemini).
2. **Local path** — Aperio installs a private copy of the **llama.cpp** engine
   *inside its own folder* (`vendor/llamacpp` — not system-wide), then looks at
   your RAM and disk and **picks a model that fits your computer**, downloading
   it once.
3. **Database & search** — a local **SQLite** database and a small on-device
   embedding model (via `transformers`) power Aperio's memory and semantic
   search. No separate model download, no server to run.
4. **Done** — Aperio opens and is ready to use.

Nothing is sent to any outside server on the local path. All AI processing
happens on your own hardware.

---

## Every Run After the First

Double-click the **Aperio** icon on your Desktop (Windows/macOS), or run
`bash START.sh` again (Linux). The launcher confirms Node, dependencies, the
engine and the model are already there, skips setup, and starts the app —
**usually ready in a few seconds**. Nothing is re-downloaded.

---

## How to Stop Aperio

- Click **Quit** in the app, **or**
- Close the launcher window (or press `Ctrl+C` inside it).

The server stops automatically.

---

## What Gets Installed — and How to Remove It

Everything Aperio installs is **contained in its own folder**, except Node.js:

| Thing | Where | Removed by uninstaller? |
|-------|-------|--------------------------|
| llama.cpp engine | `vendor/llamacpp/` (inside the app folder) | Yes |
| AI model | `~/.cache/huggingface/hub/` (shared Hugging Face cache, **outside** the app folder) | No — shared with `llama-cli` and other tools; remove manually |
| Dependencies | `node_modules/` (inside the app folder) | Yes |
| Your memory database, logs, settings | `.sqlite/`, `var/` (inside the app folder) | Yes |
| Node.js | System / `~/.nvm` | **No** — kept in case you use it elsewhere |

### To uninstall

- **Windows:** double-click **`uninstall.bat`** in the Aperio folder.
- **macOS / Linux:** run **`bash uninstall.sh`** in the Aperio folder.

The uninstaller stops the server, removes Aperio's vendored engine,
dependencies, database and logs, deletes the Desktop launcher, and *offers* to
delete the downloaded AI model. It never touches software you already had.
Finally, delete the Aperio folder itself.

---

## Troubleshooting

**"The setup page looks broken / buttons do nothing"**
> You probably opened `setup.html` directly (a `file://` address). Close that tab
> and start Aperio with `START.bat` / `bash START.sh` instead — Aperio needs its
> engine running. The correct address is `http://localhost:31337`.

**"Port 31337 is already in use"**
> Aperio may already be running — open `http://localhost:31337`. Otherwise use
> the app's **restart** option, or close the old launcher window and start again.

**"AI responses are very slow"**
> The chosen model may be large for your RAM. In **Settings → Configuration** you
> can switch to a smaller local model.

**Still stuck?**
> Open the in-app **Help** page (linked from the setup finish screen) or ask in
> [GitHub Discussions](https://github.com/BaiGanio/aperio/discussions/14).

---

*Aperio-lite — built for people, not pipelines.*

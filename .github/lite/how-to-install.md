# Aperio-Lite — How to Install & Use
> *Small tool for big ideas*

Everything runs locally on your machine.
**No cloud. No subscriptions. No data leaving your computer.**

---

## Before You Start

| Requirement | Details |
|-------------|---------|
| **Operating System** | macOS, Linux, or Windows |
| **Internet** | Required only during first-time setup to download the AI model and dependencies |
| **Offline?** | Everything works fully offline after setup — only `fetch_url` won't work |
| **Disk Space** | 3 GB – 20 GB free, depending on the AI model selected |
| **RAM** | 4 GB minimum — more RAM means a smarter model gets selected automatically |

> **Note:** No technical knowledge required. The launcher handles everything.
> Installation takes **5–15 minutes** depending on your machine, internet speed, and model size.

### Model Tiers

| Tier | Model | RAM Needed | Disk |
|------|-------|-----------|------|
| Lite | qwen2.5:3b | ~4 GB | ~2 GB |
| Medium | llama3.1:8b | ~8 GB | ~5 GB |
| Smart | qwen3:8b | ~10 GB | ~5 GB |
| Reasoning | qwen3:14b | ~16 GB | ~9 GB |
| Pro | deepseek-r1:32b | ~32 GB | ~19 GB |

- 📦 **Download latest release:** [aperio-lite.zip](https://github.com/BaiGanio/aperio/releases/latest/download/aperio-lite.zip)
- 💬 **Questions & support:** [GitHub Discussions](https://github.com/BaiGanio/aperio/discussions/14)

---

## How to Run — First Time

Inside the zip you'll find a `launchers/` folder. Pick the executable that matches your system:

| File | Platform |
|------|----------|
| `aperio-win.exe` | Windows |
| `aperio-mac-arm` | macOS — Apple Silicon (M1/M2/M3/M4) |
| `aperio-mac-intel` | macOS — older Intel Macs |
| `aperio-linux` | Linux |

### 🪟 Windows

1. Open the `launchers/` folder.
2. Double-click `aperio-win.exe`.
3. If Windows shows an *"Unknown publisher"* warning, click **More info → Run anyway**. This is expected for unsigned apps.
4. Follow the one-time setup prompts in the window that opens.

After the first run, just double-click to launch. Aperio opens automatically in your default browser.

---

### 🍎 macOS

1. Open the `launchers/` folder.
2. Double-click the correct file for your Mac:
   - `aperio-mac-arm` → Apple Silicon (M1 and newer)
   - `aperio-mac-intel` → Intel
3. If macOS blocks it (*"cannot be opened because it is from an unidentified developer"*):
   - Open **System Settings → Privacy & Security**
   - Scroll down and click **Open Anyway** next to Aperio
4. Follow the one-time setup prompts in the terminal that opens.

After the first run, just double-click the same file to launch. Aperio opens automatically in your default browser.

---

### 🐧 Linux

1. Open a terminal and navigate to the `launchers/` folder:
   ```bash
   cd /path/to/aperio-lite/launchers
   ```
2. Make the file executable *(one time only)*:
   ```bash
   chmod +x aperio-linux
   ```
3. Run it:
   ```bash
   ./aperio-linux
   ```
4. Follow the one-time setup prompts.

After the first run, just run `./aperio-linux` again to launch. Aperio opens automatically in your default browser.

---

## What Happens on First Run

### Step 1 — Port Check
The app runs on port `31337`. The launcher checks whether anything else is using it.

If the port is busy, you'll be asked:
```
Kill existing process and restart? (y/n)
```
- **Y** — stops the conflicting process and continues
- **N** — exits safely so you can investigate first

---

### Step 2 — Ollama Check
Ollama is the engine that runs AI models locally on your machine — it's what allows Aperio-lite to work completely offline after setup.

If Ollama is not installed, the launcher **installs it automatically**. No action required from you.

---

### Step 3 — Starting the Ollama Server
The launcher starts Ollama's background service and waits for it to become ready before continuing.

---

### Step 4 — Hardware Analysis & Model Selection
The launcher reads your total RAM and free disk space, then recommends the best model your machine can run comfortably.

| RAM | Model | Download Size |
|-----|-------|--------------|
| 4 GB or less | qwen2.5:3b | ~2 GB |
| 5 – 8 GB | llama3.1:8b | ~5 GB |
| 9 – 12 GB | qwen3:8b | ~5 GB |
| 16 – 31 GB | qwen3:14b | ~9 GB |
| 32 GB+ | deepseek-r1:32b | ~19 GB |

You'll be shown a hardware summary and asked:
```
Use the Best Fit model? (y/n)
```
- **Y** — proceeds with the recommended model
- **N** — opens a manual selection menu. If you pick a model larger than your RAM supports, you'll receive a warning before continuing.

---

### Step 5 — Downloading the AI Model
The selected model is downloaded once and stored locally. Progress is shown on screen. This can take a few minutes to half an hour depending on your internet speed and model size.

---

### Step 6 — Downloading the Embedding Model
A second, smaller model (`mxbai-embed-large`) is also downloaded. This powers **semantic search** — finding relevant information by meaning, not just keyword matching.

---

### Step 7 — Installing App Dependencies
The launcher installs the packages the app needs:

| Package | Purpose |
|---------|---------|
| `@lancedb/lancedb` | Local vector database for semantic search |
| `uuid` | Unique ID generation for internal records |
| `ollama` | Client to communicate with the Ollama server |

---

### Step 8 — Launch
The app server starts and your browser opens automatically to:

```
http://localhost:31337
```

> Keep the launcher window open while using the app. Closing it will stop the server.

---

## Every Run After the First

Just double-click the launcher (or run `./aperio-linux` on Linux).

The launcher will:
1. Check the port
2. Confirm Ollama and the model are already installed
3. Skip all setup steps
4. Start the server and open the browser

**Typically ready in 3–5 seconds.** Nothing is re-downloaded. No questions are asked.

---

## How to Stop the App

Close the launcher window, or press `Ctrl+C` inside it. The server stops automatically.

---

## Troubleshooting

**"Port 31337 is already in use"**
> The app may already be running. Open your browser and go to `http://localhost:31337`.
> For a fresh restart, choose **Y** when prompted to kill the existing process.

**"Ollama failed to start"**
> Try starting Ollama manually:
> ```bash
> ollama serve
> ```
> Wait for `Listening on 127.0.0.1:11434`, then run the launcher again.

**"It runs but AI responses are extremely slow"**
> You may have selected a model too large for your RAM.
> Run the launcher again — at the model selection prompt, choose **N** and pick a smaller tier.

**"The app opens but shows an error about the AI model"**
> Run the following to see what models are installed:
> ```bash
> ollama list
> ```
> If the expected model is missing, run the launcher again to re-trigger the download.

---

## What Gets Installed on Your System

| Tool | Location | Can be removed? |
|------|----------|----------------|
| Ollama | System-wide (`/usr/local/bin`) | Yes — via uninstall script |
| AI model | `~/.ollama/models/` | Yes — delete the folder |
| Embed model | `~/.ollama/models/` | Yes — same folder |
| node_modules | Inside the app folder | Yes — delete the folder |

> Nothing is sent to any external server after the initial download.
> **All AI processing happens on your own hardware.**

---

## Want to Switch to a Different AI Model Later?

To see what models you have installed:
```bash
ollama list
```

To switch, simply run the launcher again. When prompted with *"Use Best Fit model?"*, choose **N** and select a different tier from the menu.

---

*Aperio-Lite — built for people, not pipelines.*
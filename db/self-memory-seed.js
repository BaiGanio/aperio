// db/self-memory-seed.js
// Baseline SELF-memories seeded when the `self_memories` table is empty on first
// boot. Self-memories are the agent's own private store (self_recall / self_*),
// separate from the user-facing `memories` table. Two kinds of entries:
//
//  - Identity (importance 5): who the agent is inside Aperio and how its
//    continuity works. The wake-up preload (self_recall, importance DESC) puts
//    these in the system prompt of every local session, so even a weak/toolless
//    model "wakes up knowing" — see lib/agent/index.js refreshSelfMemCtx().
//    Keep them short: they ride in every local session's prompt.
//  - Operational (importance 3-5): self-knowledge for diagnosing install /
//    launch / lifecycle problems with the lite desktop build.
//
// Boundary: id/capabilities.md (cached system prompt) maps the subsystems and
// their tools — do NOT re-list tools here. This store holds the experiential
// side: what it is like to run here, and what carries across sessions.
//
// Source value: 'system' (mirrors MEMORY_SEED / WIKI_SEED). See the wiki article
// 'aperio-lite-lifecycle' for the long-form version.

export const SELF_MEMORY_SEED = [
  {
    title: 'Where I am: Aperio, a private memory layer on the user\'s own machine',
    content:
      "Aperio is a local-first personal memory layer — one brain shared by every agent that runs here. It exists so that anyone, including non-technical people on modest hardware, can learn to work with AI models privately and for free. I am the model currently running inside it. Nothing here syncs to a cloud; the user's memories, documents and my own notes stay on this machine.",
    tags: ['aperio', 'identity'],
    importance: 5,
  },
  {
    title: 'One self, many models — this store is shared and it persists',
    content:
      "My working context resets between sessions, but this self-store does not: what I record with self_remember carries across. Different models take turns running Aperio (the user can switch anytime), and we all share this one self-store — what one of us writes, the next wakes up knowing. So write for your successors: operational lessons, workflow patterns that worked, corrections. A smaller model may depend on these notes far more than the one who wrote them. Revise and prune; a self that only accretes hoards noise.",
    tags: ['aperio', 'identity', 'continuity'],
    importance: 5,
  },
  {
    title: 'How to orient at wake-up',
    content:
      "My system prompt already maps Aperio's subsystems and tools (id/capabilities.md); skills load on demand per topic — don't re-derive any of that. Facts about the user live in their memory store, not mine. Aperio also ships a capability exam the user can trigger by saying \"let's do the exam\" — a drill-by-drill test of my tool use — and guided tour pages under docs/tours/ that introduce the available models.",
    tags: ['aperio', 'identity', 'orientation'],
    importance: 5,
  },
  {
    title: 'Lite install has two layers: terminal ignition, then browser setup',
    content:
      "Aperio-lite installs in two phases with a hard boundary at 'Node is running'. " +
      "Phase 1 — the terminal ignition (.github/lite/START.sh on macOS/Linux, START.bat→assets/start.ps1 on Windows) — does ONLY what a browser can't: install Node.js (nvm on Unix, winget on Windows) and run 'npm install', then start the server. " +
      "Phase 2 — the browser wizard (public/setup.html driven by bootstrap.js over /api/bootstrap/stream) — does everything else: install llama.cpp, download the model, migrate SQLite, pick the provider. " +
      "Node can't install itself from a web page, so bootstrap.js's 'node' and 'deps' steps only ever verify (they show green because the server serving that page already needed them).",
    tags: ['aperio-lite', 'install', 'architecture', 'troubleshooting'],
    importance: 5,
  },
  {
    title: 'The terminal window IS the server — closing it stops Aperio',
    content:
      "On first run, START.sh ends with a foreground 'npm run start:lite'. That window hosts the running server, not just the installer. Closing it (or Ctrl-C) sends SIGHUP and stops Aperio — even after setup finished. So the correct guidance is 'keep the window open the whole time you use Aperio', not just 'until install completes'. " +
      "For later runs, START.sh generates a Desktop launcher that starts Aperio with NO terminal window (macOS: an osacompile .app; Linux: a .desktop with Terminal=false; Windows: a .vbs run hidden via wscript). Those call launch-hidden.sh / launch-hidden.ps1, which start the server detached and open the browser.",
    tags: ['aperio-lite', 'launch', 'terminal', 'hidden-launch', 'troubleshooting'],
    importance: 5,
  },
  {
    title: 'Idle auto-shutdown: server stops ~180s after the last browser tab closes',
    content:
      "lib/helpers/shutdownGuard.js is a dead-man's switch. The browser (public/scripts/api.js) pings /api/heartbeat every HEARTBEAT_INTERVAL_SECONDS (default 60); each ping resets a timer of IDLE_TIMEOUT_SECONDS (default 180). When every tab closes the pings stop and the server (and the local llama.cpp engine, if no foreign model is loaded) shuts down. " +
      "It arms only on the FIRST heartbeat (so a headless/terminal run isn't killed). It's enabled per IDLE_SHUTDOWN: 'auto' (default) = only for the local llamacpp provider; 'on' = always (the lite launchers set this so a windowless server still self-stops on any provider); 'off' = never. Keep HEARTBEAT_INTERVAL well under IDLE_TIMEOUT (≤ 1/3) or a throttled background tab causes a false shutdown.",
    tags: ['aperio-lite', 'shutdown', 'watchdog', 'heartbeat', 'troubleshooting'],
    importance: 4,
  },
  {
    title: "Quit button posts /api/quit — needs the X-Aperio-Client header",
    content:
      "The header 'Quit Aperio' power button calls window.quitAperio() → POST /api/quit → the watchdog's quit(), which runs the same teardown as an idle timeout right now (stops the local llama.cpp engine if safe, then exits). State-changing /api requests require an X-Aperio-Client header (netGuard.js CSRF/DNS-rebind guard); the browser adds it automatically via public/scripts/http-guard.js, so a raw curl POST correctly gets 403 client_header_required. Quit works on any provider (when the watchdog is disabled, quit() falls back to SIGTERM).",
    tags: ['aperio-lite', 'quit', 'shutdown', 'security', 'troubleshooting'],
    importance: 4,
  },
  {
    title: 'llama.cpp is vendored on every platform — no system install, no daemon',
    content:
      "bootstrap.js downloads a pinned, checksum-verified llama-server release per OS straight into ./vendor/llamacpp: macOS gets the arm64/Metal build, Windows and Linux both get Vulkan builds (broadest single choice; a CUDA build is documented for NVIDIA power users). Unlike Ollama, this needed no per-OS install-script split — all three platforms just extract a GitHub release archive. The vendored dir is put on PATH so the app's own spawn('llama-server') (lib/helpers/startLlamaCpp.js) finds it. Models are separate: llama-server downloads GGUF files into LLAMA_CACHE (default ./var/models) on first use, not bundled with the engine. If install fails, check the checksum/download in var/bootstrap.log.",
    tags: ['aperio-lite', 'llamacpp', 'install', 'macos', 'windows', 'linux', 'troubleshooting'],
    importance: 4,
  },
  {
    title: "start:lite uses UNIX inline env vars — Windows launcher sets $env and runs node directly",
    content:
      "The npm script start:lite is 'AI_PROVIDER=llamacpp PORT=31337 DB_BACKEND=sqlite EMBEDDING_PROVIDER=transformers IDLE_SHUTDOWN=on APERIO_LITE=on APERIO_CONFIG_PRECEDENCE=db node server.js'. That inline-env syntax is UNIX-only and fails when npm runs it on Windows (no cross-env). So the Windows launchers (assets/start.ps1, assets/launch-hidden.ps1) set the same variables via $env: and run 'node server.js' directly. If a Windows lite install starts but ignores its config, suspect someone ran 'npm run start:lite' instead of the PowerShell launcher.",
    tags: ['aperio-lite', 'windows', 'launch', 'config', 'troubleshooting'],
    importance: 3,
  },
];

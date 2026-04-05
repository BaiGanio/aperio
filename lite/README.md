```txt
aperio-launcher/
├── src/
│   ├── main.ts          ← orchestrates the entire flow
│   ├── ui.ts            ← all terminal output (colors, spinner, menus, prompts)
│   ├── config.ts        ← reads/writes .aperio-config.json
│   ├── port.ts          ← finds a free TCP port
│   ├── hardware.ts      ← detects RAM, CPU cores, GPU VRAM (all 3 platforms)
│   ├── model_picker.ts  ← interactive model menu with hardware-based recommendation
│   ├── ollama.ts        ← installs Ollama if missing, pulls models with live progress
│   ├── npm.ts           ← verifies Node.js exists, runs npm install with filtered output
│   └── server.ts        ← spawns Express, streams logs, opens browser, graceful shutdown
├── deno.json            ← build tasks for all 4 targets
├── package.json          
├── server.js
├── .github/workflows/build.yml ← CI: builds all 4 binaries on git tag push
└── README.md
```

deno compile --allow-net --allow-read --allow-env --env index.js
deno compile --allow-net --allow-env --env=.env.lite --output my_server index.js
Run with --allow-sys and --allow-run for full functionality.

start": "deno run --allow-net --allow-env --unstable-fs main.ts",

Important Note for Windows & Mac
Installing Node.js via .msi or .pkg usually requires Administrator/Sudo privileges. Your launcher may prompt the user for their password (on Mac/Linux) or show a UAC prompt (on Windows).




-----


#!/bin/bash
# check_env.sh - Run this in your new test user account

echo "------------------------------------------"
echo "🔍 SYSTEM PATH CHECK"
echo "------------------------------------------"

# Check for Node.js
if command -v node >/dev/null 2>&1; then
    echo "✅ Node.js: $(node -v) (at $(which node))"
else
    echo "❌ Node.js: NOT FOUND"
fi

# Check for npm
if command -v npm >/dev/null 2>&1; then
    echo "✅ npm: $(npm -v) (at $(which npm))"
else
    echo "❌ npm: NOT FOUND"
fi

# Check for Ollama
if command -v ollama >/dev/null 2>&1; then
    echo "✅ Ollama: $(ollama -v) (at $(which ollama))"
else
    echo "❌ Ollama: NOT FOUND"
fi

echo ""
echo "------------------------------------------"
echo "📂 DIRECTORY CHECK"
echo "------------------------------------------"

[ -d "$HOME/.ollama" ] && echo "⚠️  Ollama data folder exists at ~/.ollama" || echo "✅ ~/.ollama is clean"
[ -d "./node_modules" ] && echo "⚠️  node_modules exists in current dir" || echo "✅ node_modules is clean"

echo "------------------------------------------"

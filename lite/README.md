Aperio launcher

```txt
lite/
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
└── README.md
```

-----

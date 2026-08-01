// tests/e2e/fixtures/ui-server.js
// Minimal HTTP server for Playwright UI tests.
// Serves a test Config Panel page that fetches /api/config/schema and renders
// the fields. No CDN, no external deps — pure inline HTML.
//
// Env: PORT (default 0 for OS-assigned), prints "PORT:<n>\n" when ready.

import express from "express";
import { Router } from "express";
import { createServer } from "http";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { mountConfigRoutes } from "../../../lib/routes/api-config.js";
import { mountSettingsRoutes } from "../../../lib/routes/api-settings.js";
import { applyConfigToEnv } from "../../../lib/config-resolver.js";

function createMockStore(initial = {}) {
  const data = { ...initial };
  return {
    async getSettings()  { return { ...data }; },
    async getSetting(k)  { return data[k] ?? null; },
    async setSetting(k, v) { data[k] = v; return v; },
    async deleteSetting(k) { delete data[k]; return true; },
  };
}

const store = createMockStore();
await applyConfigToEnv(store);

// Create a controlled empty .env file for the config route
const envDir  = mkdtempSync(join(tmpdir(), "aperio-ui-env-"));
const envPath = join(envDir, ".env");
writeFileSync(envPath, "");

const app = express();
app.use(express.json({ limit: "64kb" }));

// API routes
const api = Router();
mountConfigRoutes(api,   { store, envPath });
mountSettingsRoutes(api, { store });
app.use("/api", api);

// SPA: serve a test Config Panel page
app.get("/", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Aperio — Config Panel (test)</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, system-ui, sans-serif; padding: 24px; background: #0d1117; color: #c9d1d9; }
    h1 { font-size: 18px; margin-bottom: 16px; color: #e6edf3; }
    .config-grid { display: grid; grid-template-columns: 220px 1fr auto; gap: 8px 12px; align-items: center; }
    .key { font-family: SFMono-Regular, Consolas, monospace; font-size: 13px; color: #8b949e; }
    .value { font-family: SFMono-Regular, Consolas, monospace; font-size: 13px; color: #e6edf3; }
    .source { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: #21262d; color: #8b949e; }
    .source.db { background: #1f6feb33; color: #58a6ff; }
    .source.env { background: #23863633; color: #3fb950; }
    .source.default { background: #21262d; color: #8b949e; }
    .precedence { margin-bottom: 16px; padding: 8px 12px; background: #161b22; border-radius: 6px; font-size: 13px; }
    .precedence span { font-weight: 600; }
    .warnings { margin-top: 16px; padding: 8px 12px; background: #3d1f0033; border: 1px solid #d2992244; border-radius: 6px; font-size: 13px; color: #d29922; }
    .loading { color: #8b949e; font-size: 13px; }
    #error { color: #f85149; font-size: 13px; display: none; margin-top: 12px; }
  </style>
</head>
<body>
  <h1>⚙ Config Panel (test)</h1>
  <div id="precedence" class="precedence">Precedence: <span id="precedence-value">loading...</span></div>
  <div id="config-grid" class="config-grid"></div>
  <div id="warnings" class="warnings" style="display:none"></div>
  <div id="error"></div>

  <script>
    async function loadConfig() {
      try {
        const r = await fetch('/api/config/schema');
        const data = await r.json();
        const grid = document.getElementById('config-grid');
        const prec = document.getElementById('precedence-value');
        const warn = document.getElementById('warnings');
        prec.textContent = data.precedence || 'env';

        // Render warnings
        if (data.warnings && data.warnings.length) {
          warn.style.display = 'block';
          warn.innerHTML = data.warnings.map(w => '<div>\\u26a0 ' + w.message + '</div>').join('');
        }

        // Render fields
        const keys = ['AI_PROVIDER', 'OLLAMA_MODEL', 'PORT', 'APERIO_CONFIG_PRECEDENCE'];
        for (const key of keys) {
          const f = data.fields.find(x => x.key === key);
          if (!f) continue;
          const div = document.createElement('div'); div.className = 'key'; div.textContent = f.key;
          const val = document.createElement('div'); val.className = 'value';
          val.textContent = f.secret ? (f.configured ? '••••' : '(unset)') : (f.value || '(unset)');
          const src = document.createElement('div'); src.className = 'source ' + (f.source || 'default');
          const label = f.source === 'db' ? 'from UI' : f.source === 'env' ? 'from .env' : 'default';
          src.textContent = label;
          grid.appendChild(div);
          grid.appendChild(val);
          grid.appendChild(src);
        }
      } catch (err) {
        document.getElementById('error').style.display = 'block';
        document.getElementById('error').textContent = 'Failed to load config: ' + err.message;
      }
    }
    loadConfig();
  </script>
</body>
</html>`);
});

const httpServer = createServer(app);
const PORT = Number(process.env.PORT || 0);
httpServer.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`PORT:${httpServer.address().port}\n`);
});

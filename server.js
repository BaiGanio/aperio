import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import path from 'path';
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { createRequire } from "module";
import { getStore, isDockerAvailable } from "./db/index.js";
import { execFile } from "child_process";
import { createAgent } from "./lib/agent.js";
import { makeWsEmitter } from "./lib/assets/wsEmitter.js";
import { preprocessBase64 } from "./mcp/assets/preprocessImage.js";
import { extractPdfText }    from "./mcp/assets/preprocessPdf.js"

const require   = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = existsSync(resolve(__dirname, ".env")) 
  ? resolve(__dirname, ".env") 
  : resolve(__dirname, ".env.example");
dotenv.config({ path: envPath });

const { version } = require("./package.json");

// ─── DB ───────────────────────────────────────────────────────────────────────
const store = await getStore();

// ─── Agent ────────────────────────────────────────────────────────────────────
const agent = await createAgent({ root: __dirname, version, clientName: "aperio-server" });
const { provider, callTool, runAgentLoop, handleRememberIntent, fetchMemories, buildGreeting, OLLAMA_NO_TOOLS, reasoningAdapter } = agent;

const providerLabel = provider.name === "anthropic"
  ? `Anthropic (${provider.model})`
  : `Ollama (${provider.model})${reasoningAdapter.match !== "__noop__" ? ` · thinking via ${reasoningAdapter.match}` : ""}`;

console.log(`🤖 Provider: ${providerLabel}`);
console.log("✅ MCP server connected");

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();

app.get("/api/version",  (_, res) => res.json({ version }));
app.get("/api/provider", (_, res) => res.json({ provider: provider.name, model: provider.model }));
app.get("/api/config",   (_, res) => res.json({ backend: process.env.DB_BACKEND || "lancedb" }));

app.get("/api/memories", async (req, res) => {
  try {
    const records = await store.table.query().limit(500).toArray();
    return res.json({ raw: records });
  } catch (e) {
    console.error("Server Error:", e);
    if (!res.headersSent) return res.status(500).json({ error: e.message });
  }
});

app.get('/api/heartbeat', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.post('/chat', async (req, res) => {
  const response = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      model: provider.model,
      messages: req.body.messages,
      stream: false // Set to false to get usage data easily in one object
    })
  });

  const data = await response.json();
  
  // Extract usage data from Ollama response
  const stats = {
    inputTokens: data.prompt_eval_count,  // Tokens in your prompt
    outputTokens: data.eval_count,       // Tokens the AI generated
    totalTokens: data.prompt_eval_count + data.eval_count
  };

  res.json({ reply: data.message.content, stats });
});

app.use(express.json());
app.use(express.static(resolve(__dirname, "public")));

// ─── WebSocket ────────────────────────────────────────────────────────────────
const httpServer = createServer(app);
const wss        = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const messages        = [];
  let   initialized     = false;
  let   abortController = null;

  const emitter = makeWsEmitter(ws);

  ws.send(JSON.stringify({ type: "status",   text: "connected" }));
  ws.send(JSON.stringify({
    type: "provider", 
    name: provider.name, 
    model: provider.model, 
    db: isDockerAvailable() ? "postgres" : "lancedb",
  }));

  async function init() {
    // Push memories to sidebar immediately
    await sendMemories(ws);

    messages.push({ role: "user", content: await buildGreeting() });

    const getAbort = () => abortController;
    const setAbort = (c) => { abortController = c; };

    await runAgentLoop(
      messages, emitter,
      provider.name === "ollama" ? { noTools: true } : {},
      getAbort, setAbort
    );
    await sendMemories(ws);
  }

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type === "init" && !initialized) {
        initialized = true;
        await init();
        return;
      }

      // ─── server.js — attachment handling block ────────────────────────────────────
      //
      // Routes every attachment into one of four paths:
      //
      //   IMAGE → .jpg .jpeg .png .gif .webp
      //           preprocessBase64() → normalised RGB PNG 896×896 → image content block
      //
      //   TEXT  → .txt .md .json .yaml .csv .js .ts .py and 20+ more
      //           Decoded from base64 → fenced code block → text content block
      //           Files > 100KB: hint to use read_file instead
      //
      //   PDF   → .pdf
      //           extractPdfText() tries text extraction first:
      //             "text"    → inline as fenced block (same as TEXT path)
      //             "scanned" → save to disk, hint agent to use preprocess_image
      //             "mixed"   → inline the text pages, hint about scanned pages
      //             "empty"   → hint that the PDF appears blank
      //           PDFs > 150KB extracted text: truncation warning + saved path
      //
      //   OTHER → Explicit hint that the file arrived but can't be read.
      //           Agent can tell the user and suggest alternatives.
      //
      // Add to the top of server.js:
      //   import { preprocessBase64 }  from "./mcp/lib/preprocessImage.js";
      //   import { extractPdfText }    from "./mcp/lib/preprocessPdf.js";
      // ─────────────────────────────────────────────────────────────────────────────

      if (data.type === "chat") {
        // 1. Start with the text part of the message
        let contentBlocks = [{ type: "text", text: data.text }];
        let hint = "";

        if (data.attachments && data.attachments.length > 0) {
          const fs        = await import("fs/promises");
          const uploadDir = resolve(__dirname, "uploads");

          try { await fs.mkdir(uploadDir, { recursive: true }); } catch {}

          // ── Extension sets ────────────────────────────────────────────────────────

          const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

          const TEXT_EXTS  = new Set([
            ".txt", ".md", ".markdown",
            ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
            ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h",
            ".json", ".yaml", ".yml", ".toml", ".env.example",
            ".html", ".css", ".scss", ".sql", ".sh", ".bash",
            ".csv", ".xml", ".graphql", ".prisma",
          ]);

          const TEXT_SIZE_LIMIT = 100 * 1024; // 100 KB

          // ── Per-attachment router ─────────────────────────────────────────────────

          for (const att of data.attachments) {
            const originalName = path.basename(att.name);
            const ext          = path.extname(originalName).toLowerCase();

            // ── IMAGE ───────────────────────────────────────────────────────────────
            if (IMAGE_EXTS.has(ext)) {
              try {
                const normalisedBase64 = await preprocessBase64(att.data, {
                  background: "white",
                  size:       896,
                });

                const safeFilename = `${uuidv4()}.png`;
                const filePath     = path.join(uploadDir, safeFilename);
                await fs.writeFile(filePath, Buffer.from(normalisedBase64, "base64"));

                console.error(`🔧 Preprocessed image: ${originalName} → ${safeFilename}`);

                contentBlocks.push({
                  type: "image",
                  source: {
                    type:       "base64",
                    media_type: "image/png",
                    data:       normalisedBase64,
                  },
                });

                hint += `\n[System: Image uploaded and normalised: ${originalName}]`;

              } catch (err) {
                console.error(`❌ preprocessImage failed for ${originalName}:`, err.message);
                hint += `\n[System: Failed to process image: ${originalName} — ${err.message}]`;
              }

            // ── TEXT ────────────────────────────────────────────────────────────────
            } else if (TEXT_EXTS.has(ext)) {
              try {
                const rawBuffer = Buffer.from(att.data, "base64");

                if (rawBuffer.length > TEXT_SIZE_LIMIT) {
                  hint += `\n[System: Text file too large to inline: ${originalName} (${Math.round(rawBuffer.length / 1024)}KB, max 100KB). Use the read_file tool with its saved path if needed.]`;
                  console.warn(`⚠️  Text attachment too large: ${originalName}`);
                  continue;
                }

                const text = rawBuffer.toString("utf8");

                contentBlocks.push({
                  type: "text",
                  text: `\n[Attached file: ${originalName}]\n\`\`\`${ext.replace(".", "")}\n${text}\n\`\`\``,
                });

                hint += `\n[System: Text file attached inline: ${originalName} (${Math.round(rawBuffer.length / 1024)}KB)]`;
                console.error(`📄 Text inlined: ${originalName} (${rawBuffer.length}B)`);

              } catch (err) {
                console.error(`❌ Text attachment failed for ${originalName}:`, err.message);
                hint += `\n[System: Failed to read text file: ${originalName} — ${err.message}]`;
              }

            // ── PDF ─────────────────────────────────────────────────────────────────
            } else if (ext === ".pdf") {
              try {
                const rawBuffer = Buffer.from(att.data, "base64");

                // Always save to disk — agent may need the path for image tools
                // if the PDF turns out to be scanned
                const safeFilename = `${uuidv4()}.pdf`;
                const savedPath    = path.join(uploadDir, safeFilename);
                await fs.writeFile(savedPath, rawBuffer);

                console.error(`📑 PDF saved: ${originalName} → ${safeFilename} (${Math.round(rawBuffer.length / 1024)}KB)`);

                const result = await extractPdfText(rawBuffer);

                console.error(
                  `📑 PDF extracted: type=${result.type} pages=${result.pageCount} ` +
                  `scanned=${result.scannedPages.length} chars=${result.text.length}`
                );

                switch (result.type) {

                  case "text": {
                    // All pages have extractable text — inline directly
                    const label = result.title ? `${originalName} — ${result.title}` : originalName;
                    contentBlocks.push({
                      type: "text",
                      text: `\n[Attached PDF: ${label} (${result.pageCount} pages)]\n\`\`\`\n${result.text}\n\`\`\`${result.truncated ? "\n⚠️ Content truncated at 80,000 characters." : ""}`,
                    });
                    hint += `\n[System: PDF text extracted and inlined: ${originalName} (${result.pageCount} pages${result.truncated ? ", truncated" : ""}). Saved path: ${savedPath}]`;
                    break;
                  }

                  case "scanned": {
                    // No extractable text — pure image PDF
                    // Give the agent the saved path so it can use preprocess_image per-page
                    hint += [
                      `\n[System: PDF uploaded but it appears to be a scanned (image-only) document: ${originalName}.`,
                      `No text could be extracted. The file has been saved to: ${savedPath}`,
                      `To analyse it, use the preprocess_image or read_image tools with that path,`,
                      `or ask the user to share individual page images directly.]`,
                    ].join(" ");
                    break;
                  }

                  case "mixed": {
                    // Some pages have text, some are scanned — inline what we have
                    const label = result.title ? `${originalName} — ${result.title}` : originalName;
                    contentBlocks.push({
                      type: "text",
                      text: `\n[Attached PDF: ${label} (${result.pageCount} pages, partial text)]\n\`\`\`\n${result.text}\n\`\`\`${result.truncated ? "\n⚠️ Content truncated at 80,000 characters." : ""}`,
                    });
                    hint += [
                      `\n[System: PDF partially extracted: ${originalName}.`,
                      `Pages with no text (likely scanned): ${result.scannedPages.join(", ")}.`,
                      `Text from other pages inlined above. Saved path for image analysis: ${savedPath}]`,
                    ].join(" ");
                    break;
                  }

                  case "empty": {
                    hint += `\n[System: PDF uploaded but appears to contain no text or images: ${originalName}. Saved to: ${savedPath}]`;
                    break;
                  }
                }

              } catch (err) {
                console.error(`❌ PDF extraction failed for ${originalName}:`, err.message);
                hint += `\n[System: Failed to process PDF: ${originalName} — ${err.message}]`;
              }

            // ── UNSUPPORTED ─────────────────────────────────────────────────────────
            } else {
              hint += `\n[System: Attachment received but not supported: ${originalName} (${ext}). Supported: images (jpg/png/gif/webp), text files (txt/md/js/ts/py/json/…), PDFs.]`;
              console.warn(`⚠️  Unsupported attachment: ${originalName}`);
            }
          }

          // 2. Attach all hints to the first (user text) block
          contentBlocks[0].text += hint;
        }

        // 3. Push to message history
        //    Backward-compat: no attachments → plain string
        const messagePayload = contentBlocks.length > 1 ? contentBlocks : data.text;
        messages.push({ role: "user", content: messagePayload });

        ws.send(JSON.stringify({ type: "thinking" }));

        if (OLLAMA_NO_TOOLS && /^remember\s+that\b/i.test(data.text.trim())) {
          console.log("🧠 remember intent | text:", data.text.substring(0, 40));
          await handleRememberIntent(data.text, emitter);
        }

        const getAbort = () => abortController;
        const setAbort = (c) => { abortController = c; };

        await runAgentLoop(messages, emitter, {}, getAbort, setAbort);
        await sendMemories(ws);
        return;
      }

      if (data.type === "stop") {
        if (abortController) { abortController.abort(); abortController = null; }
        ws.send(JSON.stringify({ type: "stream_end", text: "" }));
        return;
      }

      if (data.type === "get_memories") { await sendMemories(ws); return; }

      if (data.type === "delete_memory") {
        try {
          await callTool("forget", { id: data.id });
          ws.send(JSON.stringify({ type: "deleted", id: data.id }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", text: `Delete failed: ${err.message}` }));
        }
        return;
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", text: err.message }));
    }
  });
});

// ─── Memory helpers ───────────────────────────────────────────────────────────
async function sendMemories(ws) {
  try {
    const { parsed } = await fetchMemories();
    ws.send(JSON.stringify({ type: "memories", memories: parsed }));
  } catch (err) { console.error("Failed to fetch memories:", err.message); }
}

// ─── Background dedup ─────────────────────────────────────────────────────────
const DEDUP_INTERVAL_MS = 10 * 60 * 1000;
async function runDedup() {
  try {
    const r = await callTool("dedup_memories", { threshold: 0.97, dry_run: true });
    if (r.split("\n").filter(l => l.trim()).length > 1) console.log(`🧹 Dedup:\n${r}`);
  } catch {}
}
setTimeout(() => { runDedup(); setInterval(runDedup, DEDUP_INTERVAL_MS); }, 30_000);

// ─── Start ────────────────────────────────────────────────────────────────────
console.error("✅ Server is running from:", process.cwd());
console.error("✅ UI static file path:", resolve(__dirname, "public"));

const PORT = process.env.PORT ?? 3000;
httpServer.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n✨ Aperio running at ${url}\n`);
  // Auto-open browser — works whether launched via shell script or npm directly
  const [cmd, ...args] = process.platform === "darwin"  ? ["open", url]
                     : process.platform === "win32"   ? ["cmd", "/c", "start", url]
                     : ["xdg-open", url];
  execFile(cmd, args, (err) => {
    if (err) console.error("⚠️  Could not open browser:", err.message);
  });
});
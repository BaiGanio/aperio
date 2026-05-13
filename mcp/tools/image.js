// mcp/tools/image.js
// Image tools: read_image, preprocess_image, describe_image.
//
// read_image       — loads raw image for the agent to see.
// preprocess_image — normalizes any image to RGB PNG before VLM analysis.
// describe_image   — sends a (preprocessed) image to a local Ollama VLM
//                    and returns its text description.
//
// Requires: npm install sharp  npm install ollama

import { z }                                    from "zod";
import { readFileSync, existsSync, statSync }   from "fs";
import { extname }                              from "path";
import { spawn, exec }                          from "child_process";
import { Ollama }                               from "ollama";
import logger                                   from "../../lib/helpers/logger.js";
import { preprocessImage, preprocessBase64 }   from "../../lib/handlers/attachments/workers/preprocessImage.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIME = {
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
  ".gif":  "image/gif",
  ".webp": "image/webp",
};

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — same limit as before

// ─── Ollama / VLM config ──────────────────────────────────────────────────────

const OLLAMA_HOST      = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_VLM_MODEL = process.env.OLLAMA_VLM_MODEL || "qwen2.5vl:3b";
const OLLAMA_START_MS  = 30_000; // max wait for ollama serve to become ready

const ollamaClient = new Ollama({ host: OLLAMA_HOST });

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function detectMime(buffer, ext) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return "image/jpeg";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[8] === 0x57) return "image/webp";
  return MIME[ext] ?? "image/jpeg";
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

/**
 * read_image — unchanged from original.
 * Loads a raw image (file or base64) so the agent can see it.
 * No preprocessing — use preprocess_image first if the model misbehaves.
 */
export async function readImageHandler({ path: filePath, data: rawData, mime_type, prompt }) {
  let base64, mimeType;

  if (filePath) {
    const resolved = filePath.startsWith("~") ? filePath.replace("~", process.cwd()) : filePath;

    if (!existsSync(resolved))
      return { content: [{ type: "text", text: `❌ File not found: ${resolved}` }] };

    const stat = statSync(resolved);
    if (stat.size > MAX_BYTES)
      return { content: [{ type: "text", text: `❌ Image too large (${Math.round(stat.size / 1024 / 1024)}MB). Max 20MB.` }] };

    const ext = extname(resolved).toLowerCase();
    if (!MIME[ext])
      return { content: [{ type: "text", text: `❌ Unsupported image format: ${ext}. Supported: jpg, png, gif, webp.` }] };

    const buffer = readFileSync(resolved);
    mimeType     = mime_type ?? detectMime(buffer, ext);
    base64       = buffer.toString("base64");
    logger.warn(`🖼️ read_image: ${resolved} (${Math.round(stat.size / 1024)}KB, ${mimeType})`);

  } else {
    const headerMatch = rawData.match(/^data:([^;]+);base64,(.+)$/s);
    if (headerMatch) {
      mimeType = mime_type ?? headerMatch[1];
      base64   = headerMatch[2];
    } else {
      if (!/^[A-Za-z0-9+/=\r\n]+$/.test(rawData.slice(0, 64)))
        return { content: [{ type: "text", text: "❌ 'data' does not look like valid base64." }] };
      base64   = rawData.replace(/[\r\n]/g, "");
      mimeType = mime_type ?? "image/jpeg";
    }

    const approxBytes = Math.ceil(base64.length * 0.75);
    if (approxBytes > MAX_BYTES)
      return { content: [{ type: "text", text: `❌ Image too large (~${Math.round(approxBytes / 1024 / 1024)}MB). Max 20MB.` }] };

    logger.warn(`🖼️  read_image: base64 data (${Math.round(approxBytes / 1024)}KB, ${mimeType})`);
  }

  const content = [];
  if (prompt) content.push({ type: "text", text: prompt });
  content.push({ type: "image", data: base64, mimeType });
  return { content };
}

/**
 * preprocess_image — normalises an image before vision analysis.
 * Strips alpha, converts to sRGB, resizes with letterboxing.
 * Returns a normalised base64 PNG ready for the model to analyse.
 */
export async function preprocessImageHandler({
  path: filePath,
  data: rawData,
  background = "white",
  size       = 896,
}) {
  try {
    let base64;

    if (filePath) {
      // ── File path input ──────────────────────────────────────────────────────
      const resolved = filePath.startsWith("~") ? filePath.replace("~", process.cwd()) : filePath;

      if (!existsSync(resolved))
        return { content: [{ type: "text", text: `❌ File not found: ${resolved}` }] };

      const stat = statSync(resolved);
      if (stat.size > MAX_BYTES)
        return { content: [{ type: "text", text: `❌ Image too large (${Math.round(stat.size / 1024 / 1024)}MB). Max 20MB.` }] };

      const ext = extname(resolved).toLowerCase();
      if (!MIME[ext])
        return { content: [{ type: "text", text: `❌ Unsupported format: ${ext}. Supported: jpg, png, gif, webp.` }] };

      const buffer = await preprocessImage(resolved, { size, background });
      base64 = buffer.toString("base64");
      logger.warn(`🔧 preprocess_image: ${resolved} → RGB ${size}×${size} PNG`);

    } else if (rawData) {
      // ── Base64 input ─────────────────────────────────────────────────────────
      const approxBytes = Math.ceil(rawData.replace(/^data:[^;]+;base64,/i, "").length * 0.75);
      if (approxBytes > MAX_BYTES)
        return { content: [{ type: "text", text: `❌ Image too large (~${Math.round(approxBytes / 1024 / 1024)}MB). Max 20MB.` }] };

      base64 = await preprocessBase64(rawData, { size, background });
      logger.warn(`🔧 preprocess_image: base64 input → RGB ${size}×${size} PNG`);

    } else {
      return { content: [{ type: "text", text: "❌ Provide either 'path' or 'data'." }] };
    }

    // Return the normalised image in the same shape as read_image so the agent
    // can pass it straight to a vision model without any further wrangling.
    return {
      content: [
        {
          type: "text",
          text: `✅ Preprocessed to RGB PNG ${size}×${size} (background: ${background}). Ready for analysis.`,
        },
        {
          type:     "image",
          data:     base64,
          mimeType: "image/png",
        },
      ],
    };

  } catch (err) {
    logger.error("❌ preprocess_image error:", err);
    return { content: [{ type: "text", text: `❌ preprocess_image failed: ${err.message}` }] };
  }
}

// ─── Ollama lifecycle helpers ─────────────────────────────────────────────────

async function isOllamaUp() {
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

async function startOllama() {
  logger.info("🦙 Starting Ollama in background…");
  const proc = spawn("ollama", ["serve"], {
    detached: true,
    stdio:    "ignore",
  });
  proc.on("error", () => {}); // suppress ENOENT; poll will time out
  proc.unref();

  const deadline = Date.now() + OLLAMA_START_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    if (await isOllamaUp()) {
      logger.info("✅ Ollama ready");
      return;
    }
  }
  throw new Error("Ollama did not start within 30 s — is it installed? (https://ollama.com)");
}

function stopOllama() {
  return new Promise(resolve => {
    const cmd = process.platform === "win32"
      ? "taskkill /F /IM ollama.exe"
      : "killall ollama";
    exec(cmd, () => resolve());
  });
}

async function isSafeToStopOllama() {
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/ps`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    const { models = [] } = await r.json();
    return models.length === 0;
  } catch {
    return false;
  }
}

// ─── describe_image handler ────────────────────────────────────────────────────

/**
 * describe_image — sends a (preprocessed) image to a local Ollama VLM
 * and returns its text description.
 *
 * Lifecycle:
 *   1. Preprocess image → 896×896 RGB PNG base64
 *   2. Check if Ollama is already running
 *   3. If not → start it, use it, stop it afterwards
 *   4. If already running → use it, leave it running
 */
export async function describeImageHandler({
  path: filePath,
  data: rawData,
  prompt,
  model,
}) {
  // ── 1. Resolve image to base64 PNG ─────────────────────────────────────────
  let base64;

  try {
    if (filePath) {
      const resolved = filePath.startsWith("~") ? filePath.replace("~", process.cwd()) : filePath;

      if (!existsSync(resolved))
        return { content: [{ type: "text", text: `❌ File not found: ${resolved}` }] };

      const stat = statSync(resolved);
      if (stat.size > MAX_BYTES)
        return { content: [{ type: "text", text: `❌ Image too large (${Math.round(stat.size / 1024 / 1024)}MB). Max 20MB.` }] };

      const ext = extname(resolved).toLowerCase();
      if (!MIME[ext])
        return { content: [{ type: "text", text: `❌ Unsupported format: ${ext}. Supported: jpg, png, gif, webp.` }] };

      const buffer = await preprocessImage(resolved, { size: 896, background: "white" });
      base64 = buffer.toString("base64");
      logger.info(`🖼️  describe_image: ${resolved} → RGB 896×896 PNG`);

    } else if (rawData) {
      const approxBytes = Math.ceil(rawData.replace(/^data:[^;]+;base64,/i, "").length * 0.75);
      if (approxBytes > MAX_BYTES)
        return { content: [{ type: "text", text: `❌ Image too large (~${Math.round(approxBytes / 1024 / 1024)}MB). Max 20MB.` }] };

      base64 = await preprocessBase64(rawData, { size: 896, background: "white" });
      logger.info("🖼️  describe_image: base64 input → RGB 896×896 PNG");

    } else {
      return { content: [{ type: "text", text: "❌ Provide either 'path' or 'data'." }] };
    }
  } catch (err) {
    logger.error("❌ describe_image preprocessing error:", err);
    return { content: [{ type: "text", text: `❌ Image preprocessing failed: ${err.message}` }] };
  }

  // ── 2. Ollama lifecycle — start only if not already running ────────────────
  const wasRunning = await isOllamaUp();

  if (!wasRunning) {
    try {
      logger.info("🦙 Ollama not running — starting…");
      await startOllama();
    } catch (err) {
      return { content: [{ type: "text", text: `❌ ${err.message}` }] };
    }
  }

  // ── 3. Call the VLM ────────────────────────────────────────────────────────
  const vlmModel  = model  || OLLAMA_VLM_MODEL;
  const vlmPrompt = prompt || "Describe this image in detail.";

  try {
    logger.info(`🤖 describe_image → ${vlmModel} (${Math.round(base64.length * 0.75 / 1024)}KB image)`);

    const result = await ollamaClient.generate({
      model:      vlmModel,
      prompt:     vlmPrompt,
      images:     [base64],
      stream:     false,
      keep_alive: 0,  // unload model from VRAM immediately after response
    });

    const description = result.response || "";

    if (!description.trim()) {
      logger.warn("⚠️  describe_image: VLM returned empty response");
    }

    return { content: [{ type: "text", text: description || "(The model returned an empty response.)" }] };

  } catch (err) {
    logger.error("❌ describe_image VLM error:", err);
    const hint = err.message?.includes("not found") || err.message?.includes("unknown model")
      ? `\n\n💡 Model "${vlmModel}" may not be pulled. Try: ollama pull ${vlmModel}`
      : "";
    return { content: [{ type: "text", text: `❌ VLM call failed: ${err.message}${hint}` }] };

  } finally {
    // ── 4. Stop Ollama if nothing else is loaded ───────────────────────────
    // keep_alive: 0 already unloaded the VLM from VRAM; check /api/ps —
    // if no other models are still loaded, shut down the server too.
    const safeToStop = await isSafeToStopOllama();
    if (safeToStop) {
      logger.info(`🦙 Stopping Ollama (${wasRunning ? "was running but now idle" : "was started for VLM"})…`);
      await stopOllama();
      logger.info("✅ Ollama stopped.");
    } else if (!wasRunning) {
      logger.info("🦙 Leaving Ollama running (other models in use).");
    }
  }
}

// ─── MCP registration ─────────────────────────────────────────────────────────

export function register(server, _ctx) {

  // ── read_image ──────────────────────────────────────────────────────────────
  server.registerTool(
    "read_image",
    {
      description:
        "Load an image so the AI can see and analyse it. " +
        "Provide either a local file path OR pre-encoded base64 data (from the UI uploader). " +
        "Supported formats: JPEG, PNG, GIF, WebP. " +
        "Note: images attached by the user in the chat are already visible inline — only call this tool to load additional images from disk.",
      inputSchema: z.object({
        path: z.string().optional().describe(
          "Absolute (or ~-prefixed) path to a local image file."
        ),
        data: z.string().optional().describe(
          "Base64-encoded image data. Optionally prefix with data-URI header, e.g. 'data:image/png;base64,<data>'."
        ),
        mime_type: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]).optional().describe(
          "Force a specific MIME type. Auto-detected when omitted."
        ),
        prompt: z.string().optional().describe(
          "Optional question or instruction about the image."
        ),
      }).refine(d => d.path || d.data, {
        message: "Provide either 'path' (local file) or 'data' (base64 string).",
      }),
    },
    readImageHandler
  );

  // ── preprocess_image ────────────────────────────────────────────────────────
  server.registerTool(
    "preprocess_image",
    {
      description:
        "Normalise an image before vision analysis. " +
        "Strips alpha channels, fills transparency with a solid background, converts to RGB, " +
        "and resizes to a square with letterboxing (default 896×896). " +
        "Returns a normalised PNG the model can reliably analyse. " +
        "Use this when working with: RGBA/transparent PNGs, WebP with alpha, " +
        "GIFs, CMYK images, or any image where colours or transparency may cause issues.",
      inputSchema: z.object({
        path: z.string().optional().describe(
          "Absolute (or ~-prefixed) path to a local image file."
        ),
        data: z.string().optional().describe(
          "Base64-encoded image data (raw or data-URI format)."
        ),
        background: z.enum(["white", "dark"]).optional().default("white").describe(
          "Background fill for transparent areas and padding. " +
          "'white' for documents/light UI screenshots (default). " +
          "'dark' for dark-theme UI screenshots."
        ),
        size: z.number().int().min(224).max(2048).optional().default(896).describe(
          "Target square size in pixels (default 896 — standard for most Ollama VLMs). " +
          "Use 512 for faster processing, 1024 for high-detail images."
        ),
      }).refine(d => d.path || d.data, {
        message: "Provide either 'path' (local file) or 'data' (base64 string).",
      }),
    },
    preprocessImageHandler
  );

  // ── describe_image ──────────────────────────────────────────────────────────
  server.registerTool(
    "describe_image",
    {
      description:
        "Send an image to a local Ollama vision model (VLM) and get back a text description. " +
        "The image is automatically preprocessed to 896×896 RGB PNG before being sent. " +
        "Provide either a local file path OR base64 data. " +
        "Use this when you need to understand what's in an image — text, objects, layout, " +
        "diagrams, screenshots, handwriting, etc.\n\n" +
        "If Ollama isn't already running it will be started for this call and stopped afterwards. " +
        "If it's already running it's left as-is.",
      inputSchema: z.object({
        path: z.string().optional().describe(
          "Absolute (or ~-prefixed) path to a local image file."
        ),
        data: z.string().optional().describe(
          "Base64-encoded image data. Optionally prefix with data-URI header, e.g. 'data:image/png;base64,<data>'."
        ),
        prompt: z.string().optional().describe(
          "Question or instruction about the image. Default: 'Describe this image in detail.'"
        ),
        model: z.string().optional().describe(
          `Ollama VLM model name. Default: "${OLLAMA_VLM_MODEL}" (env OLLAMA_VLM_MODEL). ` +
          "Other good options: qwen3-vl:2b, llava:13b, gemma3:12b."
        ),
      }).refine(d => d.path || d.data, {
        message: "Provide either 'path' (local file) or 'data' (base64 string).",
      }),
    },
    describeImageHandler
  );
}
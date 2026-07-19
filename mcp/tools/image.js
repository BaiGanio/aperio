// mcp/tools/image.js
// Image tools: read_image, preprocess_image, describe_image.
//
// read_image       — loads raw image for the agent to see.
// preprocess_image — normalizes any image to RGB PNG before VLM analysis.
// describe_image   — sends a (preprocessed) image to the local llama.cpp VLM
//                    and returns its text description.
//
// Requires: npm install sharp

import { z }                                    from "zod";
import { readFileSync, existsSync, statSync }   from "fs";
import { extname }                              from "path";
import logger                                   from "../../lib/helpers/logger.js";
import { preprocessImage, preprocessBase64 }   from "../../lib/handlers/attachments/workers/preprocessImage.js";
import { LLAMACPP_MAIN_ALIAS, LLAMACPP_VLM_ALIAS } from "../../lib/helpers/llamacppAliases.js";
import { isVisionModel }                       from "../../lib/helpers/imageBridge.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIME = {
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
  ".gif":  "image/gif",
  ".webp": "image/webp",
};

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — same limit as before

// ─── llama.cpp / VLM config ───────────────────────────────────────────────────
// llama-server is fully managed by Aperio (lib/helpers/startLlamaCpp.js spawns
// and stops it at app boot/shutdown), so there is no per-call start/stop
// lifecycle here — the engine is simply assumed to be up by the time a tool
// call reaches this handler.
const LLAMACPP_BASE_URL = process.env.LLAMACPP_BASE_URL || "http://127.0.0.1:8080";
const LLAMACPP_VLM_MODEL = process.env.LLAMACPP_VLM_MODEL || "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF";
const LLAMACPP_MAIN_MODEL = process.env.LLAMACPP_MODEL || "";
const LLAMACPP_VLM_TIMEOUT_MS = Number(process.env.LLAMACPP_VLM_TIMEOUT_MS) || 300_000;
// A visual-analysis tool must return concise evidence, not consume the VLM's
// entire context when a model/template combination fails to emit EOS. This is
// a safety bound rather than a quality tuning knob: 512 tokens is ample for a
// grounded caption/OCR summary and keeps a runaway request finite.
const VLM_RESPONSE_TOKEN_LIMIT = 512;

export function resolveDescribeModel(vlmModel, configuredVlmModel = LLAMACPP_VLM_MODEL, configuredMainModel = LLAMACPP_MAIN_MODEL) {
  return vlmModel === configuredVlmModel && isVisionModel(configuredMainModel)
    ? LLAMACPP_MAIN_ALIAS
    : (vlmModel === configuredVlmModel ? LLAMACPP_VLM_ALIAS : vlmModel);
}

/** Model identifier that actually receives the pixels (not its router alias). */
export function resolveDescribeModelId(vlmModel, configuredVlmModel = LLAMACPP_VLM_MODEL, configuredMainModel = LLAMACPP_MAIN_MODEL) {
  return vlmModel === configuredVlmModel && isVisionModel(configuredMainModel)
    ? configuredMainModel
    : vlmModel;
}

/** Refuse obviously corrupt generations rather than presenting them as evidence. */
export function isDegenerateVlmOutput(text) {
  const compact = String(text || "").replace(/\s/g, "");
  if (compact.length < 32) return false;
  return new Set(compact).size <= 2;
}

export function isLlamaCppProvider() {
  return (process.env.AI_PROVIDER || "").toLowerCase() === "llamacpp";
}

/**
 * describe_image via llama-server's OpenAI-compatible /v1/chat/completions —
 * llama.cpp has no native /api/generate equivalent, so the image goes in as a
 * standard `image_url` data-URI content block (router mode loads/swaps the
 * VLM model on demand, same as the main chat model).
 */
export async function describeImageViaLlamaCpp(base64, prompt, model) {
  const vlmModel = model || LLAMACPP_VLM_MODEL;
  // Native-vision main models are deliberately the only model in the preset;
  // buildModelsPreset omits aperio-vlm to avoid loading a second multimodal
  // model. If a model nevertheless emits the describe_image tool call, route
  // it back to the already-loaded main alias instead of asking the router for
  // an alias that cannot exist in this configuration.
  const targetModel = resolveDescribeModel(vlmModel);
  const r = await fetch(`${LLAMACPP_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: targetModel,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
        ],
      }],
      max_tokens: VLM_RESPONSE_TOKEN_LIMIT,
      chat_template_kwargs: { enable_thinking: false },
      stream: false,
    }),
    signal: AbortSignal.timeout(LLAMACPP_VLM_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`llama.cpp HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content ?? "";
}

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

// ─── describe_image handler ────────────────────────────────────────────────────

/**
 * describe_image — sends a (preprocessed) image to the local llama.cpp VLM
 * and returns its text description. No per-call start/stop lifecycle — the
 * engine is already managed (spawned/stopped) by Aperio's own boot/shutdown.
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

  // ── 2. llama.cpp — no start/stop lifecycle; the engine is already managed
  // (spawned/stopped) by Aperio's own boot/shutdown, not per call. ──────────
  if (!isLlamaCppProvider()) {
    return { content: [{ type: "text", text: `❌ describe_image requires AI_PROVIDER=llamacpp (current: "${process.env.AI_PROVIDER || "unset"}").` }] };
  }

  const vlmModel  = model  || LLAMACPP_VLM_MODEL;
  const actualModel = resolveDescribeModelId(vlmModel);
  const vlmPrompt = prompt || "Describe this image in detail.";
  try {
    logger.info(`🤖 describe_image → ${actualModel} (${Math.round(base64.length * 0.75 / 1024)}KB image)`);
    const description = await describeImageViaLlamaCpp(base64, vlmPrompt, vlmModel);
    if (!description.trim()) {
      throw new Error(`VLM "${actualModel}" returned no visual evidence.`);
    }
    if (isDegenerateVlmOutput(description)) {
      throw new Error(`VLM "${actualModel}" returned degenerate output; refusing to treat it as visual evidence.`);
    }
    const preview = description.length > 300 ? description.slice(0, 300) + "…" : description;
    logger.info(`[VLM] ${actualModel} raw output:\n${preview}`);
    return { content: [{ type: "text", text: description }] };
  } catch (err) {
    logger.error("❌ describe_image VLM error:", err);
    return { content: [{ type: "text", text: `❌ VLM call failed: ${err.message}` }] };
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
          "Target square size in pixels (default 896 — standard for most VLMs). " +
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
        "Send an image to the local llama.cpp vision model (VLM) and get back " +
        "a text description. " +
        "The image is automatically preprocessed to 896×896 RGB PNG before being sent. " +
        "Provide either a local file path OR base64 data. " +
        "Use this when you need to understand what's in an image — text, objects, layout, " +
        "diagrams, screenshots, handwriting, etc.\n\n" +
        "The llama.cpp engine is already managed by Aperio, so there is no per-call start/stop step. " +
        "Requires AI_PROVIDER=llamacpp.",
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
          `VLM model name. Default: "${LLAMACPP_VLM_MODEL}" (env LLAMACPP_VLM_MODEL).`
        ),
      }).refine(d => d.path || d.data, {
        message: "Provide either 'path' (local file) or 'data' (base64 string).",
      }),
    },
    describeImageHandler
  );
}

// mcp/tools/image.js
// Image tools: read_image, preprocess_image.
//
// read_image     — existing tool, unchanged. Loads raw image for the agent to see.
// preprocess_image — new tool. Normalizes any image to RGB PNG before VLM analysis:
//                    strips alpha, fills transparency, resizes with aspect-ratio padding.
//
// Requires: npm install sharp

import { z }                                    from "zod";
import { readFileSync, existsSync, statSync }   from "fs";
import { extname }                              from "path";
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
 * preprocess_image — new tool.
 *
 * Normalises an image before sending it to a local VLM (Ollama).
 * Local models assume RGB input at a fixed resolution. This tool:
 *   1. Strips alpha — fills transparency with white or dark background
 *   2. Converts to sRGB — handles CMYK, palette, greyscale
 *   3. Resizes with letterboxing — preserves aspect ratio, pads to square
 *   4. Returns normalised base64 PNG — always RGB, always target_size×target_size
 *
 * Typical workflow:
 *   preprocess_image → read_image (with the normalised output) → model analysis
 *
 * Or use the returned base64 directly if you're calling Ollama from the agent loop.
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
          text: `✅ Preprocessed to RGB PNG ${size}×${size} (background: ${background}). Ready for VLM analysis.`,
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
        "Tip: run preprocess_image first if the model struggles with transparency or unusual formats.",
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
        "Normalise an image before sending it to a local vision model (Ollama). " +
        "Strips alpha channels, fills transparency with a solid background, converts to RGB, " +
        "and resizes to a square with letterboxing (default 896×896). " +
        "Returns a normalised PNG the model can reliably process. " +
        "Use this before read_image when working with: RGBA/transparent PNGs, WebP with alpha, " +
        "GIFs, CMYK images, or any image that causes VLM errors.",
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
}
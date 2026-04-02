// mcp/tools/image.js
// Image tool: read_image.
//
// Accepts either:
//   • path  — absolute path to a local image file
//   • data  — raw base64 string (sent directly from the UI uploader)
//
// No external dependencies — uses only Node's built-in fs and Buffer.
// Supported formats: JPEG, PNG, GIF, WebP (all natively supported by Claude).

import { z }          from "zod";
import { readFileSync, existsSync, statSync } from "fs";
import { extname }    from "path";

// Maps file extension → MCP/Claude mime type
const MIME = {
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
  ".gif":  "image/gif",
  ".webp": "image/webp",
};

// 20 MB — Claude's practical limit for base64-encoded images over MCP
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Detect mime type from the first bytes of the file (magic numbers).
 * Fallback to extension if we can't tell.
 */
function detectMime(buffer, ext) {
  // PNG  → 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  // JPEG → FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return "image/jpeg";
  // GIF  → 47 49 46
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  // WebP → 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[8] === 0x57) return "image/webp";
  // fallback to extension
  return MIME[ext] ?? "image/jpeg";
}

export function register(server, _ctx) {

  // ─── read_image ──────────────────────────────────────────────────────────────
  server.registerTool(
    "read_image",
    {
      description:
        "Load an image so the AI can see and analyse it. " +
        "Provide either a local file path OR pre-encoded base64 data (from the UI uploader). " +
        "Supported formats: JPEG, PNG, GIF, WebP.",
      inputSchema: z.object({
        path: z.string().optional().describe(
          "Absolute (or ~-prefixed) path to a local image file."
        ),
        data: z.string().optional().describe(
          "Base64-encoded image data — used when the UI uploads a file directly. " +
          "Optionally prefix with a data-URI header, e.g. 'data:image/png;base64,<data>'."
        ),
        mime_type: z.enum(["image/jpeg","image/png","image/gif","image/webp"]).optional().describe(
          "Force a specific MIME type. Auto-detected when omitted."
        ),
        prompt: z.string().optional().describe(
          "Optional question or instruction about the image, e.g. 'What does this diagram show?'"
        ),
      }).refine(d => d.path || d.data, {
        message: "Provide either 'path' (local file) or 'data' (base64 string).",
      }),
    },
    async ({ path: filePath, data: rawData, mime_type, prompt }) => {
      let base64, mimeType;

      // ── Branch A: local file path ─────────────────────────────────────────
      if (filePath) {
        const resolved = filePath.startsWith("~")
          ? filePath.replace("~", process.cwd())
          : filePath;

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
        console.error(`🖼️  read_image: ${resolved} (${Math.round(stat.size / 1024)}KB, ${mimeType})`);
      }

      // ── Branch B: base64 data from UI uploader ────────────────────────────
      else {
        // Strip data-URI header if present: "data:image/png;base64,<data>"
        const headerMatch = rawData.match(/^data:([^;]+);base64,(.+)$/s);
        if (headerMatch) {
          mimeType = mime_type ?? headerMatch[1];
          base64   = headerMatch[2];
        } else {
          // Assume raw base64 — validate it's not obviously wrong
          if (!/^[A-Za-z0-9+/=\r\n]+$/.test(rawData.slice(0, 64))) {
            return { content: [{ type: "text", text: "❌ 'data' does not look like valid base64." }] };
          }
          base64   = rawData.replace(/[\r\n]/g, "");
          mimeType = mime_type ?? "image/jpeg"; // safest default
        }

        // Size check on the decoded byte count (base64 expands by ~4/3)
        const approxBytes = Math.ceil(base64.length * 0.75);
        if (approxBytes > MAX_BYTES)
          return { content: [{ type: "text", text: `❌ Image too large (~${Math.round(approxBytes / 1024 / 1024)}MB). Max 20MB.` }] };

        console.error(`🖼️  read_image: base64 data (${Math.round(approxBytes / 1024)}KB, ${mimeType})`);
      }

      // ── Build MCP response ────────────────────────────────────────────────
      // The image block makes the image visible to the model.
      // An optional text block carries the user's prompt/question.
      const content = [];

      if (prompt) {
        content.push({ type: "text", text: prompt });
      }

      content.push({
        type:     "image",
        data:     base64,
        mimeType: mimeType,
      });

      return { content };
    }
  );
}
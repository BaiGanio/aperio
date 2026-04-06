// mcp/tools/image.js
// Image tool: read_image.

import { z }                                    from "zod";
import { readFileSync, existsSync, statSync }   from "fs";
import { extname }                              from "path";

const MIME = {
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
  ".gif":  "image/gif",
  ".webp": "image/webp",
};

const MAX_BYTES = 20 * 1024 * 1024;

export function detectMime(buffer, ext) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return "image/jpeg";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[8] === 0x57) return "image/webp";
  return MIME[ext] ?? "image/jpeg";
}

// ─── Pure handler ─────────────────────────────────────────────────────────────

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
    console.error(`🖼️  read_image: ${resolved} (${Math.round(stat.size / 1024)}KB, ${mimeType})`);
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

    console.error(`🖼️  read_image: base64 data (${Math.round(approxBytes / 1024)}KB, ${mimeType})`);
  }

  const content = [];
  if (prompt) content.push({ type: "text", text: prompt });
  content.push({ type: "image", data: base64, mimeType });
  return { content };
}

// ─── MCP registration ─────────────────────────────────────────────────────────

export function register(server, _ctx) {
  server.registerTool(
    "read_image",
    {
      description:
        "Load an image so the AI can see and analyse it. " +
        "Provide either a local file path OR pre-encoded base64 data (from the UI uploader). " +
        "Supported formats: JPEG, PNG, GIF, WebP.",
      inputSchema: z.object({
        path: z.string().optional().describe("Absolute (or ~-prefixed) path to a local image file."),
        data: z.string().optional().describe(
          "Base64-encoded image data — used when the UI uploads a file directly. " +
          "Optionally prefix with a data-URI header, e.g. 'data:image/png;base64,<data>'."
        ),
        mime_type: z.enum(["image/jpeg","image/png","image/gif","image/webp"]).optional().describe(
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
}
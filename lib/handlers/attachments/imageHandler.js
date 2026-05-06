import { writeFileSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";
import sharp from "sharp";
import path from "path";
import { preprocessBase64 } from "./workers/preprocessImage.js";

/**
 * Sanitize a user-supplied filename for safe storage and display.
 * Strips path traversal, control characters, unicode bidi overrides,
 * and truncates to a reasonable length.
 */
function sanitizeFilename(raw) {
  let safe = path.basename(raw || "unnamed");
  safe = safe.replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e]/g, "");
  if (safe.length > 200) safe = safe.slice(0, 197) + "...";
  return safe || "unnamed";
}

async function generateThumbnail(base64, { _sharp: sharpFn = sharp } = {}) {
  const buffer = Buffer.from(base64, "base64");
  const thumb = await sharpFn(buffer, { animated: false })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(200, 200, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 60 })
    .toBuffer();
  return thumb.toString("base64");
}

/**
 * Handles image attachments (jpg, jpeg, png, gif, webp).
 * Normalises to PNG via preprocessBase64, generates a small JPEG thumbnail
 * for session history, and returns an image content block for the agent.
 *
 * @param {object} att  - Raw attachment from the WebSocket message
 * @param {string} name - Original filename (will be sanitised)
 * @returns {{ blocks: object[], hint: string, meta: object }}
 */
export async function handleImage(att, name, {
  uploadDir,
  _preprocessBase64  = preprocessBase64,
  _generateThumbnail = generateThumbnail,
} = {}) {
  const safeName = sanitizeFilename(name);

  try {
    const normalisedBase64 = await _preprocessBase64(att.data, {
      background: "white",
      size: 896,
    });

    const thumbnail = await _generateThumbnail(normalisedBase64);

    mkdirSync(uploadDir, { recursive: true });
    const filename = `aperio_${randomUUID()}.png`;
    const fullPath = path.join(uploadDir, filename);
    writeFileSync(fullPath, Buffer.from(normalisedBase64, "base64"));

    const relativePath = path.join("var", "uploads", filename);
    console.log(`🔧 Preprocessed image: ${safeName} → ${relativePath}`);

    return {
      blocks: [{ type: "text", text: `[Image: ${safeName} saved to ${relativePath}]` }],
      hint: `\n[System: Image "${safeName}" has been saved to disk at ${fullPath}. Use read_image with the full path to view it, and preprocess_image first if it has transparency or unusual formatting.]`,
      meta: { name: safeName, type: "image/png", thumbnail, savedPath: fullPath },
    };
  } catch (err) {
    console.error(`❌ preprocessImage failed for ${safeName}:`, err.message);
    return {
      blocks: [],
      hint: `\n[System: Failed to save image: ${safeName} — ${err.message}]`,
      meta: { name: safeName, type: "image/png" },
    };
  }
}

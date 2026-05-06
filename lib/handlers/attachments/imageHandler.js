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

    console.log(`🔧 Preprocessed image: ${safeName}`);

    return {
      blocks: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: normalisedBase64,
          },
        },
      ],
      hint: `\n[System: Image "${safeName}" — the preprocessed base64 data is embedded as a vision block above. Describe what you see directly; no need for read_image or preprocess_image tools.]`,
      meta: { name: safeName, type: "image/png", thumbnail },
    };
  } catch (err) {
    console.error(`❌ preprocessImage failed for ${safeName}:`, err.message);
    return {
      blocks: [],
      hint: `\n[System: Failed to process image: ${safeName} — ${err.message}]`,
      meta: { name: safeName, type: "image/png" },
    };
  }
}

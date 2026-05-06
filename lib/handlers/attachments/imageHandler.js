import sharp from "sharp";
import { preprocessBase64 } from "./workers/preprocessImage.js";

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
 * @param {string} name - Original filename (already basename'd)
 * @returns {{ blocks: object[], hint: string, meta: object }}
 */
export async function handleImage(att, name, {
  _preprocessBase64  = preprocessBase64,
  _generateThumbnail = generateThumbnail,
} = {}) {
  try {
    const normalisedBase64 = await _preprocessBase64(att.data, {
      background: "white",
      size: 896,
    });

    const thumbnail = await _generateThumbnail(normalisedBase64);

    console.log(`🔧 Preprocessed image: ${name}`);

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
      hint: `\n[System: Image "${name}" is embedded as a vision content block in this message. Describe or analyse it directly — do not use any file tools to locate it.]`,
      meta: { name, type: "image/png", thumbnail },
    };
  } catch (err) {
    console.error(`❌ preprocessImage failed for ${name}:`, err.message);
    return {
      blocks: [],
      hint: `\n[System: Failed to process image: ${name} — ${err.message}]`,
      meta: { name, type: "image/png" },
    };
  }
}

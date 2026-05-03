import path from "path";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import { preprocessBase64 } from "./workers//preprocessImage.js";

/**
 * Handles image attachments (jpg, jpeg, png, gif, webp).
 * Normalises to PNG via preprocessBase64, saves to disk, and returns
 * an image content block ready to push into the messages array.
 *
 * @param {object} att        - Raw attachment from the WebSocket message
 * @param {string} name       - Original filename (already basename'd)
 * @param {string} uploadDir  - Absolute path to the uploads directory
 * @returns {{ blocks: object[], hint: string }}
 */
export async function handleImage(att, name, uploadDir, { _preprocessBase64 = preprocessBase64, _fs = fs } = {}) {
  try {
    const normalisedBase64 = await _preprocessBase64(att.data, {
      background: "white",
      size: 896,
    });

    const safeFilename = `${uuidv4()}.png`;
    const filePath = path.join(uploadDir, safeFilename);
    await _fs.writeFile(filePath, Buffer.from(normalisedBase64, "base64"));

    console.log(`🔧 Preprocessed image: ${name} → ${safeFilename}`);

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
    };
  } catch (err) {
    console.error(`❌ preprocessImage failed for ${name}:`, err.message);
    return {
      blocks: [],
      hint: `\n[System: Failed to process image: ${name} — ${err.message}]`,
    };
  }
}
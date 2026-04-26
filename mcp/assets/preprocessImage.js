// mcp/lib/preprocessImage.js
// Normalise any image to RGB, fill transparency, resize with padding.
// Used by mcp/tools/image.js → preprocess_image tool.
//
// Requires: npm install sharp

import sharp from "sharp";

const DEFAULT_SIZE = 896; // Ollama VLM default (Qwen3-VL, LLaVA, Gemma 3)

/**
 * Backgrounds for common use-cases:
 *   "white" → documents, screenshots on light UI  { r:255, g:255, b:255 }
 *   "dark"  → UI screenshots on dark themes       { r:30,  g:30,  b:30  }
 */
const BACKGROUNDS = {
  white: { r: 255, g: 255, b: 255 },
  dark:  { r: 30,  g: 30,  b: 30  },
};

/**
 * Normalise an image buffer or file path for local VLM input.
 *
 * @param {Buffer|string} input      - Raw buffer OR absolute file path
 * @param {object}        options
 * @param {number}        options.size        - Target square size in px (default 896)
 * @param {"white"|"dark"|object} options.background - Fill colour for transparency/padding
 * @returns {Promise<Buffer>}        - RGB PNG buffer, always size×size
 */
export async function preprocessImage(input, options = {}) {
  const {
    size       = DEFAULT_SIZE,
    background = "white",
  } = options;

  const bg = typeof background === "string"
    ? (BACKGROUNDS[background] ?? BACKGROUNDS.white)
    : background; // allow raw { r, g, b } object too

  const image = sharp(input, { animated: false }); // animated:false → first frame only
  const meta  = await image.metadata();

  // Log what came in — useful when debugging local model failures
  console.error(
    `🔧 preprocessImage: ${meta.format} ${meta.width}×${meta.height} ` +
    `channels=${meta.channels} alpha=${meta.hasAlpha} → RGB ${size}×${size}`
  );

  const result = await image
    // 1. Flatten alpha onto a solid background (handles RGBA, palette+alpha, greyscale+alpha)
    //    No-op for images without alpha — safe to always call.
    .flatten({ background: bg })

    // 2. Convert to sRGB — handles CMYK, Lab, greyscale, palette
    .toColorspace("srgb")

    // 3. Resize: letterbox inside size×size, pad remainder with background colour.
    //    fit:"contain" never stretches — preserves aspect ratio.
    //    withoutEnlargement:false — small images are padded up to size (not upscaled).
    .resize(size, size, {
      fit:                "contain",
      background:         bg,
      withoutEnlargement: false,
    })

    // 4. Output as PNG — lossless, always RGB, predictable byte layout for VLMs
    .png()
    .toBuffer();

  return result;
}

/**
 * Convenience: takes a base64 string (with or without data-URI header),
 * preprocesses it, and returns a fresh base64 string.
 *
 * @param {string} base64      - Raw or data-URI base64 image string
 * @param {object} options     - Same options as preprocessImage()
 * @returns {Promise<string>}  - Normalised base64 PNG string (no header)
 */
export async function preprocessBase64(base64, options = {}) {
  // Strip data-URI header if present: "data:image/png;base64,<data>" → "<data>"
  const raw    = base64.replace(/^data:[^;]+;base64,/i, "").replace(/[\r\n]/g, "");
  const buffer = Buffer.from(raw, "base64");
  const result = await preprocessImage(buffer, options);
  return result.toString("base64");
}
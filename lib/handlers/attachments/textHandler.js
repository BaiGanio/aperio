/**
 * Handles plain-text attachments (txt, md, js, ts, py, json, …).
 * Inlines the file content as a fenced code block if under the size limit.
 *
 * @param {object} att  - Raw attachment from the WebSocket message
 * @param {string} name - Original filename (already basename'd)
 * @param {string} ext  - Lowercased file extension including the dot (e.g. ".js")
 * @returns {{ blocks: object[], hint: string }}
 */

const TEXT_SIZE_LIMIT = 100 * 1024; // 100 KB

export async function handleText(att, name, ext) {
  try {
    const rawBuffer = Buffer.from(att.data, "base64");
    const sizeKb = Math.round(rawBuffer.length / 1024);

    if (rawBuffer.length > TEXT_SIZE_LIMIT) {
      console.warn(`⚠️  Text attachment too large: ${name}`);
      return {
        blocks: [],
        hint: `\n[System: Text file too large to inline: ${name} (${sizeKb}KB, max 100KB). Use the read_file tool with its saved path if needed.]`,
      };
    }

    const text = rawBuffer.toString("utf8");
    const lang = ext.replace(".", "");

    console.log(`📄 Text inlined: ${name} (${rawBuffer.length}B)`);

    return {
      blocks: [
        {
          type: "text",
          text: `\n[Attached file: ${name}]\n\`\`\`${lang}\n${text}\n\`\`\``,
        },
      ],
      hint: `\n[System: Text file attached inline: ${name} (${sizeKb}KB)]`,
    };
  } catch (err) {
    console.error(`❌ Text attachment failed for ${name}:`, err.message);
    return {
      blocks: [],
      hint: `\n[System: Failed to read text file: ${name} — ${err.message}]`,
    };
  }
}
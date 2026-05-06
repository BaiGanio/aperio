/**
 * Handles plain-text attachments (txt, md, js, ts, py, json, …).
 * Inline the full file content as a fenced code block.
 * No size limit — the full file is always sent to the agent.
 *
 * @param {object} att  - Raw attachment from the WebSocket message
 * @param {string} name - Original filename (already basename'd)
 * @param {string} ext  - Lowercased file extension including the dot (e.g. ".js")
 * @returns {{ blocks: object[], hint: string }}
 */
export async function handleText(att, name, ext) {
  try {
    const rawBuffer = Buffer.from(att.data, "base64");
    const sizeKb = Math.round(rawBuffer.length / 1024);
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
      hint: `\n[System: Text file attached in full: ${name} (${sizeKb}KB)]`,
      meta: { name, type: att.type || "text/plain" },
    };
  } catch (err) {
    console.error(`❌ Text attachment failed for ${name}:`, err.message);
    return {
      blocks: [],
      hint: `\n[System: Failed to read text file: ${name} — ${err.message}]`,
      meta: { name, type: att.type || "text/plain" },
    };
  }
}
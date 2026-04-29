import mammoth from "mammoth";

/**
 * Handles .docx attachments.
 * Uses mammoth to extract the full text content including tables,
 * headings, and lists — nothing skipped, no size limit.
 *
 * @param {object} att  - Raw attachment from the WebSocket message
 * @param {string} name - Original filename (already basename'd)
 * @returns {{ blocks: object[], hint: string }}
 */
export async function handleDocx(att, name) {
  try {
    const buffer = Buffer.from(att.data, "base64");
    const sizeKb = Math.round(buffer.length / 1024);

    // mammoth extracts full text with basic structure preserved.
    // We use extractRawText for clean plain-text — no HTML noise.
    const result = await mammoth.extractRawText({ buffer });

    const text = result.value?.trim();

    if (result.messages?.length) {
      result.messages.forEach(m => console.warn(`mammoth [${name}]:`, m.message));
    }

    if (!text) {
      return {
        blocks: [],
        hint: `\n[System: DOCX file appears to be empty or image-only: ${name}]`,
      };
    }

    console.log(`📄 DOCX extracted: ${name} (${sizeKb}KB, ${text.length} chars)`);

    return {
      blocks: [
        {
          type: "text",
          text: `\n[Attached file: ${name}]\n\`\`\`\n${text}\n\`\`\``,
        },
      ],
      hint: `\n[System: DOCX file attached in full: ${name} (${sizeKb}KB)]`,
    };
  } catch (err) {
    console.error(`❌ DOCX extraction failed for ${name}:`, err.message);
    return {
      blocks: [],
      hint: `\n[System: Failed to parse DOCX: ${name} — ${err.message}]`,
    };
  }
}
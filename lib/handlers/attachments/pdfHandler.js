import path from "path";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import { extractPdfText } from "./workers/preprocessPdf.js";

/**
 * Handles PDF attachments.
 * Always saves the raw buffer to disk (the agent may need it for image tools
 * if the PDF is scanned), then branches on the extraction result type:
 *
 *   "text"    – all pages have extractable text → inline as code block
 *   "mixed"   – some pages text, some scanned  → inline what exists + hint about scanned pages
 *   "scanned" – image-only PDF                 → hint only, agent uses vision tools
 *   "empty"   – no content at all              → hint only
 *
 * @param {object} att        - Raw attachment from the WebSocket message
 * @param {string} name       - Original filename (already basename'd)
 * @param {string} uploadDir  - Absolute path to the uploads directory
 * @returns {{ blocks: object[], hint: string }}
 */
export async function handlePdf(att, name, uploadDir, { _extractPdfText = extractPdfText, _fs = fs } = {}) {
  try {
    const rawBuffer = Buffer.from(att.data, "base64");

    // Always persist — agent may need the path for vision tools on scanned pages
    const safeFilename = `${uuidv4()}.pdf`;
    const savedPath = path.join(uploadDir, safeFilename);
    await _fs.writeFile(savedPath, rawBuffer);

    console.log(`📑 PDF saved: ${name} → ${safeFilename} (${Math.round(rawBuffer.length / 1024)}KB)`);

    const result = await _extractPdfText(rawBuffer);

    console.log(
      `📑 PDF extracted: type=${result.type} pages=${result.pageCount} ` +
      `scanned=${result.scannedPages.length} chars=${result.text.length}`
    );

    return buildPdfResult(result, name, savedPath);

  } catch (err) {
    console.error(`❌ PDF extraction failed for ${name}:`, err.message);
    return {
      blocks: [],
      hint: `\n[System: Failed to process PDF: ${name} — ${err.message}]`,
    };
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function buildPdfResult(result, name, savedPath) {
  const label = result.title ? `${name} — ${result.title}` : name;
  const truncationWarning = result.truncated ? "\n⚠️ Content truncated at 80,000 characters." : "";

  switch (result.type) {
    case "text":
      return {
        blocks: [
          {
            type: "text",
            text: `\n[Attached PDF: ${label} (${result.pageCount} pages)]\n\`\`\`\n${result.text}\n\`\`\`${truncationWarning}`,
          },
        ],
        hint: `\n[System: PDF text extracted and inlined: ${name} (${result.pageCount} pages${result.truncated ? ", truncated" : ""}). Saved path: ${savedPath}]`,
      };

    case "scanned":
      return {
        blocks: [],
        hint: [
          `\n[System: PDF uploaded but it appears to be a scanned (image-only) document: ${name}.`,
          `No text could be extracted. The file has been saved to: ${savedPath}`,
          `To analyse it, use the preprocess_image or read_image tools with that path,`,
          `or ask the user to share individual page images directly.]`,
        ].join(" "),
      };

    case "mixed":
      return {
        blocks: [
          {
            type: "text",
            text: `\n[Attached PDF: ${label} (${result.pageCount} pages, partial text)]\n\`\`\`\n${result.text}\n\`\`\`${truncationWarning}`,
          },
        ],
        hint: [
          `\n[System: PDF partially extracted: ${name}.`,
          `Pages with no text (likely scanned): ${result.scannedPages.join(", ")}.`,
          `Text from other pages inlined above. Saved path for image analysis: ${savedPath}]`,
        ].join(" "),
      };

    case "empty":
      return {
        blocks: [],
        hint: `\n[System: PDF uploaded but appears to contain no text or images: ${name}. Saved to: ${savedPath}]`,
      };

    default:
      return {
        blocks: [],
        hint: `\n[System: PDF processed with unknown result type "${result.type}": ${name}. Saved to: ${savedPath}]`,
      };
  }
}
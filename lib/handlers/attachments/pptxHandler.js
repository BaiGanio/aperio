import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";

/**
 * Handles .pptx attachments.
 * PPTX is a ZIP archive of XML files. We extract every slide's XML,
 * pull out all <a:t> text nodes, and return the full content slide-by-slide.
 * Nothing is skipped — speaker notes are included too.
 *
 * No external PPTX library needed beyond adm-zip and fast-xml-parser.
 *
 * @param {object} att  - Raw attachment from the WebSocket message
 * @param {string} name - Original filename (already basename'd)
 * @returns {{ blocks: object[], hint: string }}
 */
export async function handlePptx(att, name) {
  try {
    const buffer = Buffer.from(att.data, "base64");
    const sizeKb = Math.round(buffer.length / 1024);

    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();

    // Collect slide XML files in order (ppt/slides/slide1.xml, slide2.xml, …)
    const slideEntries = entries
      .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
      .sort((a, b) => {
        const numA = parseInt(a.entryName.match(/\d+/)?.[0] ?? "0");
        const numB = parseInt(b.entryName.match(/\d+/)?.[0] ?? "0");
        return numA - numB;
      });

    // Collect notes XML files in order (ppt/notesSlides/notesSlide1.xml, …)
    const notesEntries = entries
      .filter(e => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(e.entryName))
      .sort((a, b) => {
        const numA = parseInt(a.entryName.match(/\d+/)?.[0] ?? "0");
        const numB = parseInt(b.entryName.match(/\d+/)?.[0] ?? "0");
        return numA - numB;
      });

    if (slideEntries.length === 0) {
      return {
        blocks: [],
        hint: `\n[System: No slides found in PPTX: ${name}]`,
      };
    }

    const parser = new XMLParser({ ignoreAttributes: false });

    /**
     * Recursively walk a parsed XML node and collect all <a:t> text values.
     */
    function extractText(node) {
      if (typeof node === "string") return node;
      if (typeof node !== "object" || node === null) return "";
      const parts = [];
      for (const [key, val] of Object.entries(node)) {
        if (key === "a:t") {
          // Can be a string or array of strings
          if (Array.isArray(val)) parts.push(...val.map(String));
          else parts.push(String(val));
        } else {
          parts.push(extractText(val));
        }
      }
      return parts.filter(Boolean).join(" ");
    }

    const slideTexts = [];

    for (let i = 0; i < slideEntries.length; i++) {
      const slideNum = i + 1;
      const slideXml = slideEntries[i].getData().toString("utf8");
      const parsed = parser.parse(slideXml);
      const slideText = extractText(parsed).replace(/\s+/g, " ").trim();

      // Try to attach speaker notes for the same slide index
      let notesText = "";
      if (notesEntries[i]) {
        const notesXml = notesEntries[i].getData().toString("utf8");
        const notesParsed = parser.parse(notesXml);
        notesText = extractText(notesParsed).replace(/\s+/g, " ").trim();
      }

      let slideBlock = `--- Slide ${slideNum} ---\n${slideText || "(no text)"}`;
      if (notesText) slideBlock += `\n[Speaker notes: ${notesText}]`;
      slideTexts.push(slideBlock);
    }

    const fullText = slideTexts.join("\n\n");

    console.log(`📊 PPTX extracted: ${name} (${sizeKb}KB, ${slideEntries.length} slides)`);

    return {
      blocks: [
        {
          type: "text",
          text: `\n[Attached file: ${name} — ${slideEntries.length} slides]\n\`\`\`\n${fullText}\n\`\`\``,
        },
      ],
      hint: `\n[System: PPTX file attached in full: ${name} (${sizeKb}KB, ${slideEntries.length} slides)]`,
    };
  } catch (err) {
    console.error(`❌ PPTX extraction failed for ${name}:`, err.message);
    return {
      blocks: [],
      hint: `\n[System: Failed to parse PPTX: ${name} — ${err.message}]`,
    };
  }
}
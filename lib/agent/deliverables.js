// Answer-deliverable extraction.
//
// Extracted from lib/agent/index.js. Pure module — no agent closure state; the
// only inputs are the final answer text and a target scratch directory. The
// client-side mirror of classifyDeliverable() lives in
// public/scripts/streaming/deliverables.js, so the two must stay in agreement:
// the client hides exactly the fences the server saves to disk.

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import logger from "../helpers/logger.js";

/**
 * Classify a fenced code block as a deliverable file type, or null. Critically,
 * this does NOT rely on the model tagging the fence — weak models routinely emit
 * a bare ``` fence — so HTML/SVG are detected by sniffing the content. Explicitly
 * tagged non-deliverable languages (js/css/python…) are never sniffed.
 */
export function classifyDeliverable(lang, code) {
  const l = (lang || "").toLowerCase();
  if (l === "html" || l === "htm") return "html";
  if (l === "svg") return "svg";
  if (l === "md" || l === "markdown") return "md";
  if (l && l !== "code") return null;        // tagged as something else → not a deliverable
  if (/<!doctype html/i.test(code) || /<html[\s>]/i.test(code)) return "html";
  if (/^\s*<svg[\s>]/i.test(code)) return "svg";
  return null;
}

/**
 * A model asked to "build a page" usually emits the file inline instead of
 * writing it to disk, so nothing persists and resuming the session loses it.
 * Extract HTML/SVG/Markdown deliverables from the final answer — whether fenced
 * (```html / bare ```) or raw unfenced `<!DOCTYPE html>…` — and write each into
 * the session scratch dir so the artifact lives on disk like any other generated
 * file. The client renders the download/preview card from the message content.
 * Returns the number of files written.
 */
export function persistAnswerArtifacts(text, scratchDir) {
  if (!text || !scratchDir) return 0;
  let written = 0;
  const save = (ext, code) => {
    let base = ext === "html" ? "index.html" : `build-${written + 1}.${ext}`;
    if (ext === "html") {
      const titleMatch = code.match(/<title[^>]*>([^<]+)<\/title>/i);
      const slug = titleMatch && titleMatch[1].trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
      if (slug) base = `${slug}.html`;
    }
    const prefix = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    try {
      // The scratch dir is created lazily by file-writing tools; if the model
      // never called one (common with small models that emit code inline), it
      // won't exist yet, so create it before writing the extracted artifact.
      mkdirSync(scratchDir, { recursive: true });
      writeFileSync(join(scratchDir, `${prefix}-${base}`), code, "utf8");
      written++;
    } catch (err) {
      logger.warn(`[agent] could not persist answer artifact: ${err.message}`);
    }
  };

  // 1) Fenced deliverable blocks (tagged or bare ```).
  const rest = text.replace(/```([a-zA-Z0-9]+)?[ \t]*\r?\n([\s\S]*?)```/g, (full, lang, code) => {
    const body = code.replace(/\s+$/, "");
    const ext = classifyDeliverable(lang, body);
    if (!ext) return full;
    if (body.length < 1000 && body.split("\n").length < 20) return full;
    save(ext, body);
    return "";
  });

  // 2) Raw, unfenced HTML/SVG document (optionally wrapped in <pre><code>).
  rest.replace(
    /(?:<pre>\s*<code>\s*)?(<!doctype html\b[\s\S]*?(?:<\/html\s*>|$)|<html\b[\s\S]*?(?:<\/html\s*>|$)|<svg\b[\s\S]*?(?:<\/svg\s*>|$))(?:\s*<\/code>\s*<\/pre>)?/i,
    (full, doc) => {
      const body = doc.replace(/\s+$/, "");
      if (body.length >= 400) save(/^\s*<svg/i.test(body) ? "svg" : "html", body);
      return "";
    }
  );

  return written;
}

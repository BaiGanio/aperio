// Answer-deliverable extraction.
//
// Extracted from lib/agent/index.js. Pure module — no agent closure state; the
// only inputs are the final answer text and a target scratch directory. The
// client-side mirror of classifyDeliverable() lives in
// public/scripts/streaming/deliverables.js, so the two must stay in agreement:
// the client hides exactly the fences the server saves to disk.

import { writeFileSync, mkdirSync } from "fs";
import { join, basename } from "path";
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
 * Build a scratch-relative URL for the artifact, or null when the path is
 * outside the var/scratch/ workspace (meaning the file is not served via HTTP).
 *
 * Normalizes backslashes to forward slashes first so the check works on
 * Windows, where path.join() produces `\var\scratch\` separators.
 * Derives the URL relative to the scratch root rather than relying on a
 * fixed-depth basename, so nesting depth doesn't matter.
 */
function artifactUrl(scratchDir, filepath) {
  const normalized = scratchDir.replace(/\\/g, "/") + "/";
  const idx = normalized.indexOf("/var/scratch/");
  if (idx !== -1) {
    const rel = normalized.slice(idx + "/var/scratch/".length) + basename(filepath);
    return "/scratch/" + rel;
  }
  return null;
}

/**
 * Derive a human-readable base filename from the code content and extension.
 */
function deriveFilename(ext, code, written) {
  let base = ext === "html" ? "index.html" : `build-${written + 1}.${ext}`;
  if (ext === "html") {
    const titleMatch = code.match(/<title[^>]*>([^<]+)<\/title>/i);
    const slug = titleMatch && titleMatch[1].trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    if (slug) base = `${slug}.html`;
  }
  return base;
}

/**
 * A model asked to "build a page" usually emits the file inline instead of
 * writing it to disk, so nothing persists and resuming the session loses it.
 * Extract HTML/SVG/Markdown deliverables from the final answer — whether fenced
 * (```html / bare ```) or raw unfenced `<!DOCTYPE html>…` — and write each into
 * the session scratch dir so the artifact lives on disk like any other generated
 * file. The client renders the download/preview card from the message content.
 * Returns an array of { filename, url, sizeKb } for each artifact written.
 */
export function persistAnswerArtifacts(text, scratchDir) {
  if (!text || !scratchDir) return [];
  const artifacts = [];

  const save = (ext, code) => {
    const base = deriveFilename(ext, code, artifacts.length);
    const prefix = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    try {
      // The scratch dir is created lazily by file-writing tools; if the model
      // never called one (common with small models that emit code inline), it
      // won't exist yet, so create it before writing the extracted artifact.
      mkdirSync(scratchDir, { recursive: true });
      const filepath = join(scratchDir, `${prefix}-${base}`);
      writeFileSync(filepath, code, "utf8");
      artifacts.push({
        filename: base,
        url: artifactUrl(scratchDir, filepath),
        sizeKb: Math.max(1, Math.ceil(Buffer.byteLength(code, "utf8") / 1024)),
      });
    } catch (err) {
      logger.warn(`[agent] could not persist answer artifact: ${err.message}`);
    }
  };

  // 1) Fenced deliverable blocks (tagged or bare ```).
  // Capture the result so fenced blocks are removed from the text before the
  // raw-document scan in step 2, preventing double-matching.
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

  return artifacts;
}

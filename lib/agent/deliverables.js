// Answer-deliverable extraction.
//
// Extracted from lib/agent/index.js. Pure module — no agent closure state; the
// only inputs are the final answer text and a target scratch directory. The
// client-side mirror of classifyDeliverable() lives in
// public/scripts/streaming/deliverables.js, so the two must agree on what a
// deliverable IS and where its fence starts and ends. What they do with it
// differs on purpose: every kind is saved here, but the chat only HIDES
// html/svg behind a card — markdown stays readable in the bubble.

import { writeFileSync, mkdirSync } from "fs";
import { join, basename } from "path";
import logger from "../helpers/logger.js";

/**
 * Split text into an ordered run of parts, each covering a whole number of
 * source lines: `{ fence: false, value }` for prose, `{ fence: true, lang,
 * code, raw }` for a fenced block. Joining every part's text with "\n"
 * reproduces the input exactly.
 *
 * Fence pairing follows CommonMark — a block opened with N backticks closes
 * only on a line of N-or-more backticks and nothing else, so an info string
 * ("```mermaid") always opens and never closes — plus one repair for a shape
 * models emit constantly: same-width fences nested inside a ```markdown
 * container, where CommonMark wants a wider outer fence. Inside a markdown/md
 * block we count nesting depth so the inner pair stays content.
 *
 * The regex this replaced cut a ```markdown document at its first inner fence,
 * saving a truncated file while the chat still showed the tail. scanFences() in
 * public/scripts/markdown.js is the client mirror; the two must agree or the
 * bubble hides a different span than the one written to disk.
 */
export function scanFences(text) {
  const FENCE_LINE = /^ {0,3}(`{3,})[ \t]*(.*?)[ \t]*$/;
  const matchFence = (line) => {
    const m = FENCE_LINE.exec(String(line).replace(/\r$/, ""));
    // An info string may not contain a backtick.
    if (!m || m[2].includes("`")) return null;
    return { ticks: m[1].length, info: m[2] };
  };

  const lines = String(text).split("\n");
  const parts = [];
  let prose = [];
  const flush = () => {
    if (prose.length) { parts.push({ fence: false, value: prose.join("\n") }); prose = []; }
  };
  for (let i = 0; i < lines.length; i++) {
    const open = matchFence(lines[i]);
    if (!open) { prose.push(lines[i]); continue; }
    flush();
    const lang = open.info.split(/\s+/)[0] || "";
    const container = /^(?:markdown|md)$/i.test(lang);
    let depth = 1;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const f = matchFence(lines[j]);
      if (!f) continue;
      if (!f.info && f.ticks >= open.ticks) {
        if (--depth === 0) { close = j; break; }
      } else if (container && f.info) {
        depth++;
      }
    }
    // A fence the model opened but never closed takes the rest of the text.
    const end = close === -1 ? lines.length : close;
    parts.push({
      fence: true,
      closed: close !== -1,
      lang,
      code: lines.slice(i + 1, end).join("\n"),
      raw: lines.slice(i, close === -1 ? lines.length : close + 1).join("\n"),
    });
    i = end;
  }
  flush();
  return parts;
}

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
  const rest = scanFences(text)
    .map((part) => {
      if (!part.fence) return part.value;
      const body = part.code.replace(/\s+$/, "");
      const ext = classifyDeliverable(part.lang, body);
      if (!ext) return part.raw;
      if (body.length < 1000 && body.split("\n").length < 20) return part.raw;
      save(ext, body);
      return "";
    })
    .join("\n");

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

// lib/server/locale.js — request locale detection (cookie, then Accept-Language,
// then DEFAULT_LOCALE/en) and the index/setup HTML renderer that stamps the
// detected locale as a data attribute (no inline <script> — CSP has no
// 'unsafe-inline'/nonce for script-src).

import { readFileSync } from "fs";
import { resolve } from "path";

export const I18N_COOKIE = "aperio_lang";

export const SUPPORTED_LOCALES = new Set([
  "en", "bg", "de", "fr", "es", "it", "pt", "nl", "pl", "ro",
  "el", "sv", "da", "fi", "cs", "sk", "sl", "hr", "hu", "et",
  "lv", "lt", "mt", "ga", "zh", "ja",
]);

function readCookieFromHeader(header, name) {
  if (!header) return null;
  const match = header.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

function pickLocaleFromHeader(header) {
  if (!header) return null;
  const candidates = header.split(",").map(part => {
    const [tag, ...params] = part.trim().split(";");
    const q = params.find(p => p.trim().startsWith("q="));
    const quality = q ? parseFloat(q.split("=")[1]) : 1;
    return { tag: tag.toLowerCase(), q: Number.isFinite(quality) ? quality : 1 };
  }).sort((a, b) => b.q - a.q);
  for (const { tag } of candidates) {
    const base = tag.split("-")[0];
    if (SUPPORTED_LOCALES.has(base)) return base;
  }
  return null;
}

export function detectLocale(req) {
  const fromCookie = readCookieFromHeader(req.headers.cookie, I18N_COOKIE);
  if (fromCookie && SUPPORTED_LOCALES.has(fromCookie)) return fromCookie;
  return pickLocaleFromHeader(req.headers["accept-language"]) || process.env.DEFAULT_LOCALE || "en";
}

export function createHtmlRenderer({ root }) {
  let _indexHtmlCache = null;
  let _setupHtmlCache = null;
  function readHtml(file) {
    if (file === "index.html") {
      if (_indexHtmlCache == null) _indexHtmlCache = readFileSync(resolve(root, "public", file), "utf8");
      return _indexHtmlCache;
    }
    if (file === "setup.html") {
      if (_setupHtmlCache == null) _setupHtmlCache = readFileSync(resolve(root, "public", file), "utf8");
      return _setupHtmlCache;
    }
    return readFileSync(resolve(root, "public", file), "utf8");
  }

  function renderHtmlWithLocale(file, lang) {
    const html = readHtml(file);
    return html.replace(/<html\b/, `<html data-aperio-lang="${lang}"`);
  }

  return { renderHtmlWithLocale };
}

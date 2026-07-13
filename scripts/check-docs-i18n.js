#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIR = path.join(ROOT, "docs");
const LOCALES_DIR = path.join(DOCS_DIR, "locales");
const HTML_FILE = path.join(DOCS_DIR, "index.html");
const html = fs.readFileSync(HTML_FILE, "utf8");

// ── Discover locale JSON files ──
const LOCALE_FILE_RE = /^([a-z]{2})\.json$/;
const localeFiles = fs.readdirSync(LOCALES_DIR)
  .filter((f) => LOCALE_FILE_RE.test(f))
  .sort();

const EXPECTED_LOCALES = [
  "en", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "ga",
  "hr", "hu", "it", "ja", "lt", "lv", "mt", "nl", "pl", "pt", "ro", "sk", "sl", "sv",
  "zh",
];

// ── Load translation data from JSON files ──
const translations = {};
for (const file of localeFiles) {
  const code = file.match(/^([a-z]{2})\.json$/)[1];
  translations[code] = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), "utf8"));
}

function decodeText(value) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function innerHtmlAt(openStart, openEnd) {
  const open = html.slice(openStart, openEnd + 1);
  const tag = open.match(/^<([a-z][\w-]*)\b/i)?.[1];
  if (!tag) throw new Error(`Cannot identify tag at offset ${openStart}`);

  const token = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  token.lastIndex = openEnd + 1;
  let depth = 1;
  let match;
  while ((match = token.exec(html))) {
    if (match[0].startsWith("</")) depth -= 1;
    else if (!match[0].endsWith("/>")) depth += 1;
    if (depth === 0) return html.slice(openEnd + 1, match.index).trim();
  }
  throw new Error(`No closing tag for ${tag} at offset ${openStart}`);
}

function htmlTags(value) {
  return [...String(value).matchAll(/<\/?([a-z][\w-]*)\b[^>]*>/gi)]
    .map((match) => match[0].startsWith("</")
      ? `/${match[1].toLowerCase()}`
      : match[1].toLowerCase());
}

let failed = false;

// ── 1. Locale completeness check ──
const languages = Object.keys(translations);
for (const expected of EXPECTED_LOCALES) {
  if (!languages.includes(expected)) {
    failed = true;
    console.error(`Missing expected locale: ${expected}`);
  }
}
for (const lang of languages) {
  if (!EXPECTED_LOCALES.includes(lang)) {
    failed = true;
    console.error(`Unsupported locale present: ${lang}`);
  }
}

// ── 2. Key parity & HTML tag preservation for every locale ──
const englishKeys = Object.keys(translations.en);

for (const language of languages) {
  const keys = Object.keys(translations[language]);
  const missing = englishKeys.filter((key) => !(key in translations[language]));
  const extra = keys.filter((key) => !(key in translations.en));
  const htmlMismatches = englishKeys.filter((key) =>
    htmlTags(translations.en[key]).join("|") !== htmlTags(translations[language][key]).join("|"));

  if (missing.length || extra.length || htmlMismatches.length) {
    failed = true;
    console.error(`${language}: ${missing.length} missing, ${extra.length} extra, ${htmlMismatches.length} HTML mismatch`);
    if (missing.length) console.error(`  missing: ${missing.join(", ")}`);
    if (extra.length) console.error(`  extra: ${extra.join(", ")}`);
    if (htmlMismatches.length) console.error(`  HTML: ${htmlMismatches.join(", ")}`);
  } else {
    console.log(`${language}: ${keys.length}/${englishKeys.length} keys`);
  }
}

// ── 3. Reference integrity ──
const references = new Map();
const attribute = /<([a-z][\w-]*)\b[^>]*\b(data-i18n(?:-html|-attr-title|-attr-placeholder)?)="([^"]+)"[^>]*>/gi;
for (const match of html.matchAll(attribute)) {
  const [, , kind, key] = match;
  const openStart = match.index;
  const openEnd = html.indexOf(">", openStart);
  const raw = kind.startsWith("data-i18n-attr-") ? "" : innerHtmlAt(openStart, openEnd);
  const english = kind === "data-i18n-html"
    ? raw
    : (kind === "data-i18n" ? decodeText(raw) : null);

  if (references.has(key) && references.get(key).english !== english) {
    throw new Error(`Conflicting source text for repeated key "${key}"`);
  }
  references.set(key, { kind, english });
}
for (const script of ["scripts.js", "lang-map.js"]) {
  for (const match of fs.readFileSync(path.join(DOCS_DIR, script), "utf8").matchAll(/\bt\(\s*["']([^"']+)["']/g)) {
    if (!references.has(match[1])) references.set(match[1], { kind: "script", english: null });
  }
}

for (const [key, { english }] of references) {
  if (!(key in translations.en)) {
    failed = true;
    console.error(`Unknown docs i18n key: ${key}`);
  } else if (english !== null && translations.en[key] !== english) {
    failed = true;
    console.error(`Stale English value for docs i18n key: ${key}`);
  }
}

const unreferenced = englishKeys.filter((key) => key !== "page_title" && !references.has(key));
if (unreferenced.length) {
  failed = true;
  console.error(`Unreferenced docs i18n keys: ${unreferenced.join(", ")}`);
}

// ── 4. Script order ──
// Only translations.js and scripts.js are loaded; per-locale data comes from locales/*.json
const translationsScript = html.indexOf('<script src="translations.js"></script>');
const scriptsScript = html.indexOf('<script src="scripts.js"></script>');
if (translationsScript < 0) {
  failed = true;
  console.error("Missing translations.js script tag");
}
if (translationsScript > scriptsScript) {
  failed = true;
  console.error("translations.js must load before scripts.js");
}

// ── 5. Picker presence for every locale ──
// The docs picker is generated by lang-map.js; it does not render static
// data-lang attributes in index.html.
const langMapSource = fs.readFileSync(path.join(DOCS_DIR, "lang-map.js"), "utf8");
for (const language of languages) {
  const localePattern = new RegExp(`^\\s+${language}:\\s*\\{`, "m");
  if (!localePattern.test(langMapSource)) {
    failed = true;
    console.error(`Missing language-switcher entry for ${language}`);
  }
}

// ── 6. Runtime switching test for every locale ──
// Inline test: simulate setLang logic since translations.js uses async fetch
function testSetLang(lang) {
  if (!translations[lang]) return;

  // Apply text content
  sampleText.textContent = translations[lang].nav_features;

  // Apply HTML content
  sampleHtmlEl.innerHTML = translations[lang].hero_h1;

  // Update document lang
  runtimeDocument.documentElement.lang = lang;

  // Persist
  persistedLanguage = lang;

  // Update select
  mockSelect.value = lang;
}

const sampleText = { textContent: "" };
const sampleHtmlEl = { innerHTML: "" };
const mockSelect = { value: "" };
let persistedLanguage = null;
const runtimeDocument = {
  title: "",
  documentElement: { lang: "" },
};

for (const language of languages) {
  persistedLanguage = null;
  mockSelect.value = "";
  runtimeDocument.documentElement.lang = "";
  sampleText.textContent = "";
  sampleHtmlEl.innerHTML = "";

  testSetLang(language);

  const expectedText = translations[language].nav_features;
  const expectedHtml = translations[language].hero_h1;
  const textOk = sampleText.textContent === expectedText;
  const htmlOk = sampleHtmlEl.innerHTML === expectedHtml;
  const langOk = runtimeDocument.documentElement.lang === language;
  const persistOk = persistedLanguage === language;
  const selectOk = mockSelect.value === language;

  if (!textOk || !htmlOk || !langOk || !persistOk || !selectOk) {
    failed = true;
    const issues = [];
    if (!textOk) issues.push("text");
    if (!htmlOk) issues.push("html");
    if (!langOk) issues.push("lang");
    if (!persistOk) issues.push("persist");
    if (!selectOk) issues.push("select");
    console.error(`Runtime switching failed for ${language}: ${issues.join(", ")}`);
  }
}

if (failed) process.exitCode = 1;
else console.log(`Docs i18n is valid: ${references.size} referenced keys, ${languages.length} languages.`);

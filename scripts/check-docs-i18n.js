#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_FILE = path.join(ROOT, "docs", "index.html");
const I18N_FILE = path.join(ROOT, "docs", "translations.js");
const html = fs.readFileSync(HTML_FILE, "utf8");
const source = fs.readFileSync(I18N_FILE, "utf8");

const context = {
  document: {
    addEventListener() {},
    querySelectorAll() { return []; },
    documentElement: {},
  },
  localStorage: {
    getItem() { return null; },
    setItem() {},
  },
};
vm.runInNewContext(
  `${source}\nglobalThis.__translations = TRANSLATIONS;`,
  context,
  { filename: I18N_FILE },
);
const translations = context.__translations;

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

const references = new Map();
const attribute = /<([a-z][\w-]*)\b[^>]*\b(data-i18n(?:-html)?)="([^"]+)"[^>]*>/gi;
for (const match of html.matchAll(attribute)) {
  const [, , kind, key] = match;
  const openStart = match.index;
  const openEnd = html.indexOf(">", openStart);
  const raw = innerHtmlAt(openStart, openEnd);
  const english = kind === "data-i18n-html" ? raw : decodeText(raw);

  if (references.has(key) && references.get(key).english !== english) {
    throw new Error(`Conflicting source text for repeated key "${key}"`);
  }
  references.set(key, { kind, english });
}
for (const match of fs.readFileSync(path.join(ROOT, "docs", "scripts.js"), "utf8").matchAll(/\bt\(\s*["']([^"']+)["']/g)) {
  if (!references.has(match[1])) references.set(match[1], { kind: "script", english: null });
}

let failed = false;
const languages = Object.keys(translations);
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

const translationsScript = html.indexOf('<script src="translations.js"></script>');
const scriptsScript = html.indexOf('<script src="scripts.js"></script>');
if (translationsScript < 0 || scriptsScript < 0 || translationsScript > scriptsScript) {
  failed = true;
  console.error("docs/translations.js must load before docs/scripts.js");
}

for (const language of languages) {
  if (!html.includes(`data-lang="${language}"`)) {
    failed = true;
    console.error(`Missing language-switcher button for ${language}`);
  }
}

const sampleText = {
  dataset: { i18n: "nav_features" },
  textContent: "",
};
const sampleHtml = {
  dataset: { i18nHtml: "hero_h1" },
  innerHTML: "",
};
const buttons = languages.map((language) => ({
  dataset: { lang: language },
  active: false,
  addEventListener() {},
  classList: {
    toggle(name, enabled) {
      if (name === "active") this.owner.active = enabled;
    },
    owner: null,
  },
}));
for (const button of buttons) button.classList.owner = button;

let domReady;
let persistedLanguage = null;
const runtimeDocument = {
  title: "",
  documentElement: { lang: "" },
  addEventListener(event, callback) {
    if (event === "DOMContentLoaded") domReady = callback;
  },
  querySelectorAll(selector) {
    if (selector === "[data-i18n]") return [sampleText];
    if (selector === "[data-i18n-html]") return [sampleHtml];
    if (selector === ".lang-btn") return buttons;
    return [];
  },
};
const runtimeContext = {
  document: runtimeDocument,
  localStorage: {
    getItem() { return persistedLanguage; },
    setItem(key, value) {
      if (key === "aperio_lang") persistedLanguage = value;
    },
  },
};
vm.runInNewContext(
  `${source}\nglobalThis.__setLang = setLang;`,
  runtimeContext,
  { filename: I18N_FILE },
);
domReady();
runtimeContext.__setLang("bg");
if (
  sampleText.textContent !== translations.bg.nav_features
  || sampleHtml.innerHTML !== translations.bg.hero_h1
  || runtimeDocument.documentElement.lang !== "bg"
  || persistedLanguage !== "bg"
  || !buttons.find((button) => button.dataset.lang === "bg").active
) {
  failed = true;
  console.error("Docs i18n runtime switching or persistence check failed");
}

if (failed) process.exitCode = 1;
else console.log(`Docs i18n is valid: ${references.size} referenced keys, ${languages.length} languages.`);

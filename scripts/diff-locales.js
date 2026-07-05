#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const I18N_FILE = path.join(ROOT, "public", "scripts", "i18n.js");
const LOCALES_DIR = path.join(ROOT, "public", "locales");
const PUBLIC_DIR = path.join(ROOT, "public");

function loadCanonicalEnglish() {
  const source = fs.readFileSync(I18N_FILE, "utf8");
  const document = {
    cookie: "",
    readyState: "loading",
    addEventListener() {},
    querySelectorAll() { return []; },
    documentElement: { dataset: {} },
  };
  const window = { location: { href: "http://localhost/" }, Aperio: {} };
  const context = {
    document,
    window,
    localStorage: { getItem() { return null; }, setItem() {} },
    navigator: { languages: ["en"], language: "en" },
    URL,
    fetch() {},
    CustomEvent: class CustomEvent {},
  };

  vm.runInNewContext(
    `${source}\nglobalThis.__canonicalEnglish = TRANSLATIONS.en;`,
    context,
    { filename: I18N_FILE },
  );
  return context.__canonicalEnglish;
}

function placeholders(value) {
  return [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

function htmlTags(value) {
  return [...String(value).matchAll(/<\/?([a-z][\w-]*)\b[^>]*>/gi)]
    .map((match) => match[0].startsWith("</") ? `/${match[1].toLowerCase()}` : match[1].toLowerCase())
    .sort();
}

const canonical = loadCanonicalEnglish();
const canonicalKeys = Object.keys(canonical);
const localeFiles = fs.readdirSync(LOCALES_DIR)
  .filter((file) => file.endsWith(".json"))
  .sort();

let hasErrors = false;

for (const file of localeFiles) {
  const locale = path.basename(file, ".json");
  let translations;
  try {
    translations = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), "utf8"));
  } catch (error) {
    hasErrors = true;
    console.error(`${locale}: invalid JSON (${error.message})`);
    continue;
  }

  const missing = canonicalKeys.filter((key) => !(key in translations));
  const extra = Object.keys(translations).filter((key) => !(key in canonical));
  const placeholderMismatches = canonicalKeys
    .filter((key) => key in translations)
    .filter((key) => placeholders(canonical[key]).join(",") !== placeholders(translations[key]).join(","));
  const htmlMismatches = canonicalKeys
    .filter((key) => key in translations)
    .filter((key) => htmlTags(canonical[key]).join(",") !== htmlTags(translations[key]).join(","));

  if (missing.length || extra.length || placeholderMismatches.length || htmlMismatches.length) {
    hasErrors = true;
    console.error(`${locale}: ${missing.length} missing, ${extra.length} extra, ${placeholderMismatches.length} placeholder mismatch, ${htmlMismatches.length} HTML mismatch`);
    if (missing.length) console.error(`  missing: ${missing.join(", ")}`);
    if (extra.length) console.error(`  extra: ${extra.join(", ")}`);
    if (placeholderMismatches.length) console.error(`  placeholders: ${placeholderMismatches.join(", ")}`);
    if (htmlMismatches.length) console.error(`  HTML: ${htmlMismatches.join(", ")}`);
  } else {
    console.log(`${locale}: ${canonicalKeys.length}/${canonicalKeys.length} keys`);
  }
}

const sourceFiles = [];
function collectSourceFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (filename !== LOCALES_DIR) collectSourceFiles(filename);
    } else if (/\.(?:html|js)$/.test(entry.name) && filename !== I18N_FILE) {
      sourceFiles.push(filename);
    }
  }
}
collectSourceFiles(PUBLIC_DIR);

const referencedKeys = new Map();
const referencePatterns = [
  /data-i18n(?:-html|-attr-title|-attr-placeholder)?=["']([^"']+)["']/g,
  /(?:\bt|window\.t)\(\s*["']([^"']+)["']/g,
];
for (const filename of sourceFiles) {
  const source = fs.readFileSync(filename, "utf8");
  for (const pattern of referencePatterns) {
    for (const match of source.matchAll(pattern)) {
      if (!match[1].includes("${") && !referencedKeys.has(match[1])) {
        referencedKeys.set(match[1], filename);
      }
    }
  }
}

const unknownReferences = [...referencedKeys.keys()].filter((key) => !(key in canonical));
if (unknownReferences.length) {
  hasErrors = true;
  console.error(`Unknown keys referenced by the public UI:`);
  for (const key of unknownReferences) {
    console.error(`  ${key}: ${path.relative(ROOT, referencedKeys.get(key))}`);
  }
} else {
  console.log(`All ${referencedKeys.size} statically referenced UI keys exist in the English baseline.`);
}

if (hasErrors) process.exitCode = 1;
else console.log(`All ${localeFiles.length} locales match the ${canonicalKeys.length}-key English baseline.`);

/**
 * Aperio docs landing-page translation runtime.
 *
 * Per-locale data is loaded from locales/<code>.json files.
 * This file handles fetching, caching, and applying translations.
 */

const LOCALE_CODES = [
  "en", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "ga",
  "hr", "hu", "it", "ja", "lt", "lv", "mt", "nl", "pl", "pt", "ro", "sk", "sl", "sv",
  "zh",
];

const I18N_STORAGE_KEY = "aperio_lang";
const storedLang = localStorage.getItem(I18N_STORAGE_KEY);
let currentLang = LOCALE_CODES.includes(storedLang) ? storedLang : "en";
let TRANSLATIONS = {};

async function loadTranslations() {
  const results = await Promise.all(
    LOCALE_CODES.map(async (code) => {
      const res = await fetch(`locales/${code}.json`);
      if (!res.ok) throw new Error(`Failed to load locales/${code}.json`);
      return { code, data: await res.json() };
    })
  );
  const map = {};
  for (const { code, data } of results) {
    map[code] = data;
  }
  return map;
}

function t(key) {
  return TRANSLATIONS[currentLang]?.[key] ?? TRANSLATIONS.en?.[key] ?? key;
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-html]").forEach((element) => {
    element.innerHTML = t(element.dataset.i18nHtml);
  });
  document.title = t("page_title");
  document.documentElement.lang = currentLang;
}

function setLang(lang) {
  if (!TRANSLATIONS[lang]) return;
  currentLang = lang;
  localStorage.setItem(I18N_STORAGE_KEY, lang);
  applyTranslations();
  const select = document.getElementById("langSelect");
  if (select) select.value = lang;
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    TRANSLATIONS = await loadTranslations();
  } catch (e) {
    console.error("Aperio i18n: failed to load translations", e);
    return;
  }
  currentLang = LOCALE_CODES.includes(storedLang) ? storedLang : "en";
  applyTranslations();
  const select = document.getElementById("langSelect");
  if (select) {
    select.value = currentLang;
    select.addEventListener("change", (e) => setLang(e.target.value));
  }
});

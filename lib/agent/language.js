// lib/agent/language.js — Language directive for multi-lingual system prompts.
//
// Extracted from lib/agent/index.js. Pure data + one pure function.

export const LANG_NAMES = {
  en: "English", bg: "Bulgarian", de: "German", fr: "French", es: "Spanish",
  it: "Italian", pt: "Portuguese", nl: "Dutch", pl: "Polish", ro: "Romanian",
  el: "Greek", sv: "Swedish", da: "Danish", fi: "Finnish", cs: "Czech",
  sk: "Slovak", sl: "Slovenian", hr: "Croatian", hu: "Hungarian", et: "Estonian",
  lv: "Latvian", lt: "Lithuanian", mt: "Maltese", ga: "Irish",
};

export function buildLanguageDirective(lang) {
  const name = LANG_NAMES[lang];
  if (!name || lang === "en") return null;
  return `LANGUAGE DIRECTIVE — highest priority, overrides all other instructions:\n` +
    `The user's interface language is ${name} (${lang}). ` +
    `You MUST think and reason in ${name}. Do NOT use English in your reasoning chain — think in ${name} from the first token. ` +
    `Respond to the user in ${name} using natural, native phrasing. ` +
    `Exception: if the user explicitly writes in a different language, mirror that language for both thinking and response. ` +
    `Keep code, identifiers, file paths, CLI snippets, and proper names in their original form.`;
}

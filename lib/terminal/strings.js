// lib/terminal/strings.js — English source strings + locale overlay for the
// terminal's welcome/help copy (#178 Phase 4).
//
// English is bundled inline as the source and the guaranteed fallback (same
// approach as the Web UI's i18n.js). Other languages overlay matching keys from
// public/locales/<lang>.json — the very files the Web UI ships — so translators
// have one place to work. A missing key (or missing/broken file) falls back to
// English, so adding a language is purely additive and English never regresses.
//
// The shared locale files namespace terminal strings with a `cli_` prefix
// (LOCALE_PREFIX) so they can't collide with the Web UI's keys; internally we
// use the bare names. A translator adds e.g. "cli_help_title" to de.json.
//
// Runnable `try:` examples are deliberately NOT here: they are copy-paste
// commands ("attach ~/Downloads/report.pdf"), identical in every language.

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

// Tests (and relocations) can point APERIO_LOCALES_DIR elsewhere; default is the
// repo's public/locales next to the Web UI bundle.
function localesDir() {
  return process.env.APERIO_LOCALES_DIR
    ? resolve(process.env.APERIO_LOCALES_DIR)
    : resolve(dirname(fileURLToPath(import.meta.url)), "../../public/locales");
}

export const EN = {
  // welcome banner
  welcome_tagline:        "— your local thinking partner",
  welcome_privacy:        "Everything runs on your machine. Nothing leaves it.",
  welcome_intro:          "New here? Just type like you'd text a clever friend. For example:",
  welcome_ex_summarize:   "summarize this",
  welcome_ex_summarize_h: "(then paste an article or email)",
  welcome_ex_plan:        "help me plan my week",
  welcome_ex_explain:     "explain this",
  welcome_ex_explain_h:   "(then paste some code)",
  welcome_help_pre:       "Type ",
  welcome_help_post:      " anytime to see everything I can do.",

  // help shell
  help_title:        "How to talk to Aperio",
  help_intro:        "Mostly, just type what you want in plain words. The words below are\n  shortcuts you can type on their own line.",
  help_sec_everyday: "Everyday",
  help_sec_deeper:   "Deeper thinking",
  help_sec_yours:    "Your stuff",
  help_sec_display:  "Display & exit",
  help_tip_pre:      "Tip: type ",
  help_tip_mid:      " to hide these, or ",
  help_tip_post:     " for one command.",

  // command one-liners
  desc_attach:    "add a PDF, image, or document to your next message",
  desc_summarize: "boil this conversation down to a few bullet points",
  desc_remember:  "tell me something to keep in mind for next time",
  desc_discuss:   "have two of me debate before answering (then: discuss off)",
  desc_memories:  "see what I've remembered about you",
  desc_forget:    "make me forget one thing",
  desc_sessions:  "list your past conversations",
  desc_resume:    "pick a past conversation back up",
  desc_handoff:   "write a summary to start fresh without losing context",
  desc_examples:  "show or hide the try: examples below each command",
  desc_lang:      "switch language (e.g. lang de) — English by default",
  desc_restart:   "start a fresh conversation (restart --hard reloads from scratch)",
  desc_reasoning: "show or hide my thinking out loud",
  desc_stats:     "show or hide the token counter under each answer",
  desc_status:    "show the technical details (model, storage, mode)",
  desc_clear:     "clear the screen",
  desc_exit:      "leave Aperio (or press Ctrl+C twice)",

  // help <command> detail bodies
  detail_attach:    "Queue a file to ride along with your next message. PDFs, images, and\n  common documents are read and added as context — just type your question\n  on the following line.",
  detail_summarize: "Boil the current conversation down to a few bullet points. Handy before a\n  handoff or when a thread has run long.",
  detail_remember:  "Save a durable fact about you or your preferences so it carries across\n  sessions. Phrase it as a plain sentence after \"remember that\".",
  detail_memories:  "List everything I've remembered about you. Pair with forget <id> to prune.",
  detail_forget:    "Drop a single remembered item by its id. Run memories first to see the ids.",
  detail_sessions:  "List your recent conversations with their ids, then pick one back up with\n  resume <id>.",
  detail_resume:    "Reopen a past conversation by id (the short hash shown in sessions) and\n  continue where you left off.",
  detail_handoff:   "Write a summary of the current thread so you can start fresh without\n  losing context. Add a focus to steer what the summary keeps.",
  detail_discuss:   "Have two of me debate before answering, then converge. Turn it off the\n  same way. (Available when connected to a running Aperio server.)",
  detail_examples:  "Toggle the dimmed try: example lines under each command in help. Your\n  choice is remembered across sessions.",
  detail_lang:      "Switch the interface language for welcome and help text. Type lang on\n  its own to see the current choice and the full list of codes; your choice\n  is saved for next time.",
  detail_restart:   "Start a fresh conversation. Bare restart saves the current session and\n  starts a new one instantly. restart --hard relaunches Aperio from scratch,\n  reloading .env and config (bare restart also relaunches when connected to a\n  running server).",
  detail_reasoning: "Show or hide my thinking out loud as I work through an answer.",
  detail_stats:     "Show or hide the token counter printed under each answer.",
  detail_status:    "Print the technical details: model, storage backend, and run mode.",

  // lang command feedback
  lang_current:   "language",          // "language: English (en)"
  lang_set:       "language set to",    // "language set to German (de)"
  lang_unknown:   "unknown language",
  lang_available: "available — type",   // "available — type lang <code>:"
};

const LOCALE_PREFIX = "cli_";
const cache = new Map();

// Resolve the string table for a language: English overlaid with any matching,
// non-empty `cli_`-prefixed keys from <localesDir>/<lang>.json. Cached per (dir, lang).
export function resolveStrings(lang = "en") {
  if (!lang || lang === "en") return EN;
  const dir = localesDir();
  const cacheKey = `${dir}:${lang}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let merged = EN;
  try {
    const locale = JSON.parse(readFileSync(resolve(dir, `${lang}.json`), "utf-8"));
    const overlay = {};
    for (const key of Object.keys(EN)) {
      const v = locale[LOCALE_PREFIX + key];
      if (typeof v === "string" && v.trim()) overlay[key] = v;
    }
    merged = { ...EN, ...overlay };
  } catch { /* keep English */ }

  cache.set(cacheKey, merged);
  return merged;
}

/**
 * i18n.js — Aperio Web UI internationalization
 *
 * Supported locales: all 24 official EU languages.
 *  - en is bundled inline as the immediate fallback.
 *  - All other locales are fetched lazily from /locales/<lang>.json on first use.
 *  - If a fetch fails the English fallback stays in place — zero downtime.
 *
 * HTML markup:
 *   <span data-i18n="key">English fallback</span>          → textContent
 *   <span data-i18n-html="key">English <br> fallback</span> → innerHTML (use for tags)
 *   <button data-i18n-attr-title="key">…</button>          → title attribute
 *   <input data-i18n-attr-placeholder="key">               → placeholder attribute
 *
 * JS usage:
 *   t("key")                     → translated string (or English fallback)
 *   t("key", { count: 3 })       → with simple {placeholder} interpolation
 *   getCurrentLang()             → current locale code
 *   setLang("de")                → switch language; persists to cookie + localStorage
 */

/* ── Locale metadata ─────────────────────────────────────────────────────── */
const LOCALE_META = {
  en: { flag: "🇬🇧", name: "English",     englishName: "English" },
  bg: { flag: "🇧🇬", name: "Български",   englishName: "Bulgarian" },
  de: { flag: "🇩🇪", name: "Deutsch",     englishName: "German" },
  fr: { flag: "🇫🇷", name: "Français",    englishName: "French" },
  es: { flag: "🇪🇸", name: "Español",     englishName: "Spanish" },
  it: { flag: "🇮🇹", name: "Italiano",    englishName: "Italian" },
  pt: { flag: "🇵🇹", name: "Português",   englishName: "Portuguese" },
  nl: { flag: "🇳🇱", name: "Nederlands",  englishName: "Dutch" },
  pl: { flag: "🇵🇱", name: "Polski",      englishName: "Polish" },
  ro: { flag: "🇷🇴", name: "Română",      englishName: "Romanian" },
  el: { flag: "🇬🇷", name: "Ελληνικά",    englishName: "Greek" },
  sv: { flag: "🇸🇪", name: "Svenska",     englishName: "Swedish" },
  da: { flag: "🇩🇰", name: "Dansk",       englishName: "Danish" },
  fi: { flag: "🇫🇮", name: "Suomi",       englishName: "Finnish" },
  cs: { flag: "🇨🇿", name: "Čeština",     englishName: "Czech" },
  sk: { flag: "🇸🇰", name: "Slovenčina",  englishName: "Slovak" },
  sl: { flag: "🇸🇮", name: "Slovenščina", englishName: "Slovenian" },
  hr: { flag: "🇭🇷", name: "Hrvatski",    englishName: "Croatian" },
  hu: { flag: "🇭🇺", name: "Magyar",      englishName: "Hungarian" },
  et: { flag: "🇪🇪", name: "Eesti",       englishName: "Estonian" },
  lv: { flag: "🇱🇻", name: "Latviešu",    englishName: "Latvian" },
  lt: { flag: "🇱🇹", name: "Lietuvių",    englishName: "Lithuanian" },
  mt: { flag: "🇲🇹", name: "Malti",       englishName: "Maltese" },
  ga: { flag: "🇮🇪", name: "Gaeilge",     englishName: "Irish" },
};

const SUPPORTED_LANGS = Object.keys(LOCALE_META);

/* ── Translations — en is bundled inline as the immediate fallback ───────── */
const TRANSLATIONS = {
  en: {
    page_title:               "Aperio",
    title_thinking:           "● Aperio is thinking",

    nav_toggle_sidebar_show:  "Show sidebar ({key}B)",
    nav_toggle_sidebar_hide:  "Hide sidebar ({key}B)",
    nav_chats:                "💬 chats",
    nav_paths:                "📂 paths",
    nav_chats_plain:          "Chats",
    nav_paths_plain:          "Paths",
    nav_theme_title:          "Theme",
    nav_chats_title:          "Conversation history",
    nav_paths_title:          "Allowed paths",
    nav_reasoning_title:      "Enable reasoning",
    nav_reasoning_on:         "on",
    nav_reasoning_off:        "off",
    nav_lang_title:           "Language",
    nav_theme_light:          "Light",
    nav_theme_dark:           "Dark",
    nav_theme_aurora:         "Aurora",
    nav_theme_system:         "System",

    status_connecting:        "connecting…",
    status_connected:         "connected",
    status_reconnected:       "reconnected",
    status_disconnected:      "disconnected",
    status_thinking:          "thinking…",
    status_typing:            "typing…",
    status_loading:           "loading…",

    ctx_label:                "context",

    sidebar_memories:         "Memories",
    sidebar_export_title:     "Export brain to JSON",
    sidebar_export:           "Export",
    sidebar_import_title:     "Import memories from JSON",
    sidebar_import:           "Import",
    sidebar_search:           "Search memories…",
    sidebar_loading:          "Loading memories…",
    sidebar_empty_title:      "No memories yet",
    sidebar_empty_hint_html:  "Tell Aperio something worth keeping.<br>Try: <em>\"Remember that I prefer TypeScript\"</em>",
    sidebar_show_less:        "▴ show less",
    sidebar_show_more:        "▾ {n} more",

    type_facts:               "Facts",
    type_preferences:         "Preferences",
    type_projects:            "Projects",
    type_decisions:           "Decisions",
    type_solutions:           "Solutions",
    type_sources:             "Sources",
    type_people:              "People",
    type_inferences:          "Inferences",

    mem_delete_title:         "Delete memory",
    mem_delete_confirm:       "Delete \"{title}\"?",
    mem_importance:           "Importance",
    mem_pin:                  "Pin memory",
    mem_unpin:                "Unpin memory",
    mem_pinned_group:         "Pinned",
    mem_just_now:             "just now",
    mem_min_ago:              "{n}m ago",
    mem_hour_ago:             "{n}h ago",
    mem_day_ago:              "{n}d ago",

    chat_placeholder:         "Ask anything — or say 'scan my project at ~/…'",
    chat_send_title:          "Send ({key}+Enter)",
    chat_stop_title:          "Stop generating",
    chat_attach_title:        "Attach file or image",
    chat_input_hint_html:     "{key} + ↵ to send &nbsp;·&nbsp; ↵ for newline",
    chat_input_thinking:      "Aperio is thinking…",
    chat_input_warning:       "Your AI agent is not almighty. Do not trust the output blindly!",
    chat_thinking_label:      "thinking…",
    chat_loading_label:       "loading…",
    chat_uploaded_files:      "Uploaded {n} file(s)",
    chat_chars:               "{n} chars",
    chat_attach_remove:       "Remove",

    stats_with_thinking:      "🪙 {total} total tokens → ✍️ {answer} response · 🧠 +{thinking} thinking · 🚙 speed: {speed} tok/s · ⏱️ completed: {sec}",
    stats_plain:              "🪙 {answer} tokens · 🚙 speed: {speed} tok/s · ⏱️ completed: {sec}",

    msg_preparing_answer:     "✦ preparing answer…",
    msg_reasoning_done:       "done",
    msg_reasoning_header:     "🧠 Reasoning",
    msg_reasoning_flat:       "✍️ Reasoning",
    msg_streaming:            "streaming…",

    startup_tokens_from:      "{n} tokens at startup ·",
    startup_memory_one:       "1 memory",
    startup_memory_many:      "{n} memories",
    startup_skill_one:        "1 skill",
    startup_skill_many:       "{n} skills",
    startup_tool_one:         "1 tool",
    startup_tool_many:        "{n} tools",

    recall_pill_one:          "Recalled 1 memory",
    recall_pill_many:         "Recalled {n} memories",

    ttl_chip_in_days:         "expires in {n} days",
    ttl_chip_tomorrow:        "expires tomorrow",
    ttl_chip_expired:         "already expired",
    ttl_chip_keep:            "Keep expiry",
    ttl_chip_permanent:       "Never expire",
    ttl_chip_removing:        "Removing…",

    tool_recall:              "Searching memories…",
    tool_remember:            "Saving memory…",
    tool_forget:              "Deleting memory…",
    tool_update_memory:       "Updating memory…",
    tool_backfill_embeddings: "Generating embeddings…",
    tool_deduplicate_memories:"Checking for duplicates…",
    tool_read_file:           "Reading file…",
    tool_scan_project:        "Scanning project…",
    tool_fetch_url:           "Fetching URL…",
    tool_generic:             "Using {name}…",

    sug_title:                "✦ Memory suggestions",
    sug_save_all:             "Save all",
    sug_skip:                 "Skip",
    sug_save_n:               "Save {n}",

    sessions_title:           "History",
    sessions_select:          "Select",
    sessions_cancel:          "Cancel",
    sessions_count_one:       "1 selected",
    sessions_count_many:      "{n} selected",
    sessions_bulk_delete:     "Delete selected",
    sessions_loading:         "Loading…",
    sessions_empty_html:      "No past sessions yet.<br>Conversations are saved when you close the tab.",
    sessions_load_failed:     "Failed to load sessions.",
    sessions_summaries:       "Summaries",
    sessions_resume:          "Resume",
    sessions_no_summaries:    "No summaries yet for this session.",
    sessions_summary_meta:    "{time} · {n} messages at checkpoint",
    sessions_resumed_html:    "<i class=\"bi bi-arrow-counterclockwise\"></i> Resumed: <strong>{title}</strong>",
    sessions_dismiss:         "Dismiss",
    sessions_paths_restored:  "<i class=\"bi bi-folder-check\"></i> Paths restored from previous session",
    sessions_summary_one:     "summary",
    sessions_summary_many:    "summaries",
    sessions_in_progress:     "in progress",
    sessions_delete_one:      "Delete session \"{title}\"?\nThis cannot be undone.",
    sessions_delete_many:     "Delete {n} sessions?\nThis cannot be undone.",
    sessions_delete_failed:   "Failed to delete session: {error}",
    sessions_delete_n_failed: "{n} session(s) could not be deleted.",
    sessions_deleting:        "Deleting…",
    sessions_loading_short:   "Loading…",
    sessions_untitled:        "Untitled",
    sessions_pin:             "Pin",
    sessions_unpin:           "Unpin",

    paths_title:              "Allowed Paths",
    paths_read_label:         "Read Paths",
    paths_read_hint:          "Folders the AI can read files from",
    paths_write_label:        "Write Paths",
    paths_write_hint:         "Folders the AI can write files to",
    paths_pick_title:         "Browse for folder (opens Finder)",
    paths_input_placeholder:  "/Users/you/your-project",
    paths_session_note_html:  "<i class=\"bi bi-info-circle\"></i> Changes apply to this session only — not saved to disk.",
    paths_cancel:             "Cancel",
    paths_apply:              "Apply",
    paths_applying:           "Applying…",
    paths_applied:            "Applied!",
    paths_apply_failed:       "Failed to apply paths: {error}",
    paths_empty:              "No paths configured",
    paths_remove_title:       "Remove",

    preview_close:            "Close",

    export_confirm:           "Aperio will export {n} memories in JSON file?",
    import_parse_failed:      "Could not parse file — make sure it is a valid Aperio JSON export.",
    import_invalid_array:     "The file does not contain a valid memories array.",
    import_confirm_one:       "Import {n} memory from \"{file}\"?",
    import_confirm_many:      "Import {n} memories from \"{file}\"?",
    import_done_one:          "Imported {n} memory successfully.",
    import_done_many:         "Imported {n} memories successfully.",
    import_done_with_errors:  "Imported {n} memories. {e} skipped.",
    import_error:             "Import error: {error}",

    ctx_warn:                 "Context is {pct}% full — older messages will be dropped soon.",
    ctx_trimmed:              "Older messages were dropped to fit context ({pct}% full).",
    ctx_summarize:            "Summarize",
    ctx_dismiss:              "Dismiss",
    ctx_summarize_failed:     "⚠ Could not summarize: {reason}",
    ctx_summarize_no_save:    "Summary generated but could not be saved to memory — it will be lost on refresh.",
    ctx_summarize_ok:         "✓ Conversation summarized and saved to memory.",
    ctx_suggestions_saved_one:  "✓ 1 suggestion saved to memory",
    ctx_suggestions_saved_many: "✓ {n} suggestions saved to memory",

    discuss_button_label:     "Discuss",
    discuss_button_tooltip:   "Two agents will cross-review answers",
    roundtable_phase_answer:        "answering",
    roundtable_phase_review:        "reviewing A's answer",
    roundtable_phase_revise:        "revising in response to B",
    roundtable_phase_rereview:      "re-reviewing A's revision",
    roundtable_phase_status:        "{model} · {action}…",
    roundtable_consensus_label:     "Consensus",
    roundtable_no_consensus_banner: "No consensus after {n} rounds",
    roundtable_position_a:          "Agent A's position",
    roundtable_position_b:          "Agent B's position",

    setup_page_title:         "Aperio — Setup",
    setup_intro_h1:           "One-time setup",
    setup_intro_p_html:       "Installing dependencies — this only happens once.<br>Future starts are instant.",
    setup_starting:           "Starting…",
    setup_step_of:            "Step {n} of {total}",
    setup_all_done:           "All done",
    setup_done_banner:        "Setup complete — Aperio is ready.",
    setup_open_aperio:        "Open Aperio",
    setup_error_default:      "Setup failed. Check bootstrap.log for details.",
    setup_error_prefix:       "Setup failed: {msg}",
    setup_step_node:          "Node.js & npm",
    setup_step_deps:          "Dependencies",
    setup_step_ollama:        "Ollama",
    setup_step_model:         "AI Model",
    setup_step_lancedb:       "LanceDB & Embeddings",
    setup_badge_idle:         "waiting",
    setup_badge_running:      "running…",
    setup_badge_done:         "done",
    setup_badge_skipped:      "ready",
    setup_badge_error:        "error",
    setup_detail_waiting:     "Waiting…",
  },
};

/* ── Engine ──────────────────────────────────────────────────────────────── */
const I18N_STORAGE_KEY = "aperio_lang";
const I18N_COOKIE_KEY  = "aperio_lang";

function readCookie(name) {
  const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

function writeCookie(name, value, days = 365) {
  const exp = new Date(Date.now() + days * 86400e3).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; expires=${exp}; SameSite=Lax`;
}

function pickInitialLang() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("lang");
  if (fromUrl && SUPPORTED_LANGS.includes(fromUrl)) return fromUrl;

  const fromCookie = readCookie(I18N_COOKIE_KEY);
  if (fromCookie && SUPPORTED_LANGS.includes(fromCookie)) return fromCookie;

  if (typeof window.__APERIO_LANG__ === "string" && SUPPORTED_LANGS.includes(window.__APERIO_LANG__)) {
    return window.__APERIO_LANG__;
  }

  const fromStorage = localStorage.getItem(I18N_STORAGE_KEY);
  if (fromStorage && SUPPORTED_LANGS.includes(fromStorage)) return fromStorage;

  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language || "en"];
  for (const tag of candidates) {
    const base = String(tag).toLowerCase().split("-")[0];
    if (SUPPORTED_LANGS.includes(base)) return base;
  }

  return "en";
}

let currentLang = pickInitialLang();

/* Tracks which locales have been fetched (or attempted) so we never double-fetch. */
const _localeLoaded = new Set(["en"]);

async function loadLocale(lang) {
  if (_localeLoaded.has(lang)) return;
  _localeLoaded.add(lang); // mark before fetch so concurrent calls don't race
  try {
    const res = await fetch(`/locales/${lang}.json`);
    if (res.ok) TRANSLATIONS[lang] = await res.json();
  } catch { /* network failure — English fallback remains */ }
}

function interpolate(str, params) {
  if (!params) return str;
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
}

function t(key, params) {
  const dict = TRANSLATIONS[currentLang] || {};
  const raw = dict[key] != null ? dict[key] : (TRANSLATIONS.en[key] != null ? TRANSLATIONS.en[key] : key);
  return interpolate(raw, params);
}

function getCurrentLang() { return currentLang; }
function getLocaleMeta(lang) { return LOCALE_META[lang] || LOCALE_META.en; }
function getSupportedLangs() { return [...SUPPORTED_LANGS]; }

function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach(el => {
    const params = el.dataset.i18nParams ? safeJSON(el.dataset.i18nParams) : null;
    el.textContent = t(el.dataset.i18n, params);
  });
  root.querySelectorAll("[data-i18n-html]").forEach(el => {
    const params = el.dataset.i18nParams ? safeJSON(el.dataset.i18nParams) : null;
    el.innerHTML = t(el.dataset.i18nHtml, params);
  });
  root.querySelectorAll("[data-i18n-attr-title]").forEach(el => {
    el.title = t(el.dataset.i18nAttrTitle);
  });
  root.querySelectorAll("[data-i18n-attr-placeholder]").forEach(el => {
    el.placeholder = t(el.dataset.i18nAttrPlaceholder);
  });
  if (root === document) {
    document.title = t("page_title");
    document.documentElement.lang = currentLang;
    document.documentElement.dataset.lang = currentLang;
  }
}

function safeJSON(s) { try { return JSON.parse(s); } catch { return null; } }

async function setLang(lang) {
  if (!SUPPORTED_LANGS.includes(lang) || lang === currentLang) return;
  await loadLocale(lang);
  currentLang = lang;
  localStorage.setItem(I18N_STORAGE_KEY, lang);
  writeCookie(I18N_COOKIE_KEY, lang);
  applyTranslations();
  document.dispatchEvent(new CustomEvent("aperio:lang-changed", { detail: { lang } }));
}

/* ── Boot ────────────────────────────────────────────────────────────────── */
// Apply English immediately (synchronous), then fetch the real locale if needed.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    applyTranslations();
    if (currentLang !== "en") loadLocale(currentLang).then(() => applyTranslations());
  });
} else {
  applyTranslations();
  if (currentLang !== "en") loadLocale(currentLang).then(() => applyTranslations());
}

/* Expose to global scope for non-module scripts */
window.Aperio = window.Aperio || {};
Object.assign(window.Aperio, {
  t,
  setLang,
  getCurrentLang,
  getLocaleMeta,
  getSupportedLangs,
  applyTranslations,
  TRANSLATIONS,
  LOCALE_META,
});
window.t = t;

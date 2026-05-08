/**
 * i18n.js — Aperio Web UI internationalization
 *
 * Supported locales: all 24 official EU languages.
 *  - en, bg are fully translated.
 *  - The other 22 fall back to English until translations are added.
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
// Flag emoji + native language name for the dropdown switcher.
// Keys are the 2-letter ISO codes used by Aperio.
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

/* ── Translations ────────────────────────────────────────────────────────── */
const TRANSLATIONS = {
  en: {
    /* Page title */
    page_title:               "Aperio",
    title_thinking:           "● Aperio is thinking",

    /* Navbar / header */
    nav_toggle_sidebar_show:  "Show sidebar ({key}B)",
    nav_toggle_sidebar_hide:  "Hide sidebar ({key}B)",
    nav_chats:                "💬 chats",
    nav_paths:                "📂 paths",
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

    /* Status pill */
    status_connecting:        "connecting…",
    status_connected:         "connected",
    status_reconnected:       "reconnected",
    status_disconnected:      "disconnected",
    status_thinking:          "thinking…",
    status_typing:            "typing…",
    status_loading:           "loading…",

    /* Context bar */
    ctx_label:                "context",

    /* Sidebar */
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

    /* Memory types (sidebar group labels) */
    type_facts:               "Facts",
    type_preferences:         "Preferences",
    type_projects:            "Projects",
    type_decisions:           "Decisions",
    type_solutions:           "Solutions",
    type_sources:             "Sources",
    type_people:              "People",

    /* Memory card */
    mem_delete_title:         "Delete memory",
    mem_delete_confirm:       "Delete \"{title}\"?",
    mem_importance:           "Importance",
    mem_just_now:             "just now",
    mem_min_ago:              "{n}m ago",
    mem_hour_ago:             "{n}h ago",
    mem_day_ago:              "{n}d ago",

    /* Chat / input bar */
    chat_placeholder:         "Ask anything — or say 'scan my project at ~/…'",
    chat_send_title:          "Send ({key}+Enter)",
    chat_stop_title:          "Stop generating",
    chat_attach_title:        "Attach file or image",
    chat_input_hint_html:     "{key}↵ to send &nbsp;·&nbsp; Shift↵ for newline",
    chat_input_thinking:      "Aperio is thinking…",
    chat_input_warning:       "Your AI agent is not almighty. Do not trust the output blindly!",
    chat_thinking_label:      "thinking…",
    chat_loading_label:       "loading…",
    chat_uploaded_files:      "Uploaded {n} file(s)",
    chat_chars:               "{n} chars",
    chat_attach_remove:       "Remove",

    /* Message UI (dynamic strings in message-handler.js) */
    msg_preparing_answer:     "✦ preparing answer…",
    msg_reasoning_done:       "done",
    msg_reasoning_header:     "🧠 Reasoning",
    msg_reasoning_flat:       "✍️ Reasoning",
    msg_streaming:            "streaming…",

    /* Startup context banner */
    startup_tokens_from:      "{n} tokens preloaded from",
    startup_memory_one:       "1 memory",
    startup_memory_many:      "{n} memories",
    startup_skill_one:        "1 skill",
    startup_skill_many:       "{n} skills",
    startup_tool_one:         "1 tool",
    startup_tool_many:        "{n} tools",

    /* Tool indicators */
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

    /* Memory suggestions block */
    sug_title:                "✦ Memory suggestions",
    sug_save_all:             "Save all",
    sug_skip:                 "Skip",
    sug_save_n:               "Save {n}",

    /* Sessions panel */
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

    /* Paths modal */
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

    /* Memory preview modal */
    preview_close:            "Close",

    /* Import / Export */
    export_confirm:           "Aperio will export {n} memories in JSON file?",
    import_parse_failed:      "Could not parse file — make sure it is a valid Aperio JSON export.",
    import_invalid_array:     "The file does not contain a valid memories array.",
    import_confirm_one:       "Import {n} memory from \"{file}\"?",
    import_confirm_many:      "Import {n} memories from \"{file}\"?",
    import_done_one:          "Imported {n} memory successfully.",
    import_done_many:         "Imported {n} memories successfully.",
    import_done_with_errors:  "Imported {n} memories. {e} skipped.",
    import_error:             "Import error: {error}",

    /* Context-window banners */
    ctx_warn:                 "Context is {pct}% full — older messages will be dropped soon.",
    ctx_trimmed:              "Older messages were dropped to fit context ({pct}% full).",
    ctx_summarize:            "Summarize",
    ctx_dismiss:              "Dismiss",
    ctx_summarize_failed:     "⚠ Could not summarize: {reason}",
    ctx_summarize_no_save:    "Summary generated but could not be saved to memory — it will be lost on refresh.",
    ctx_suggestions_saved_one:  "✓ 1 suggestion saved to memory",
    ctx_suggestions_saved_many: "✓ {n} suggestions saved to memory",

    /* Setup / bootstrap */
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

  bg: {
    /* Заглавия */
    page_title:               "Aperio",
    title_thinking:           "● Aperio мисли",

    /* Навигация / горен бар */
    nav_toggle_sidebar_show:  "Покажи страничната лента ({key}B)",
    nav_toggle_sidebar_hide:  "Скрий страничната лента ({key}B)",
    nav_chats:                "💬 чатове",
    nav_paths:                "📂 папки",
    nav_chats_title:          "История на разговорите",
    nav_paths_title:          "Разрешени папки",
    nav_reasoning_title:      "Включи разсъждение",
    nav_reasoning_on:         "вкл.",
    nav_reasoning_off:        "изкл.",
    nav_lang_title:           "Език",
    nav_theme_light:          "Светла",
    nav_theme_dark:           "Тъмна",
    nav_theme_aurora:         "Aurora",
    nav_theme_system:         "Системна",

    /* Статус */
    status_connecting:        "свързване…",
    status_connected:         "свързано",
    status_reconnected:       "възстановено",
    status_disconnected:      "прекъснато",
    status_thinking:          "мисля…",
    status_typing:            "пиша…",
    status_loading:           "зареждам…",

    /* Контекстна лента */
    ctx_label:                "контекст",

    /* Странична лента */
    sidebar_memories:         "Спомени",
    sidebar_export_title:     "Експорт на мозъка в JSON",
    sidebar_export:           "Експорт",
    sidebar_import_title:     "Импорт на спомени от JSON",
    sidebar_import:           "Импорт",
    sidebar_search:           "Търсене на спомени…",
    sidebar_loading:          "Зареждам спомени…",
    sidebar_empty_title:      "Все още няма спомени",
    sidebar_empty_hint_html:  "Кажете на Aperio нещо, което си струва да запомни.<br>Пример: <em>\"Запомни, че предпочитам TypeScript\"</em>",
    sidebar_show_less:        "▴ покажи по-малко",
    sidebar_show_more:        "▾ още {n}",

    /* Типове спомени */
    type_facts:               "Факти",
    type_preferences:         "Предпочитания",
    type_projects:            "Проекти",
    type_decisions:           "Решения",
    type_solutions:           "Намерени решения",
    type_sources:             "Източници",
    type_people:              "Хора",

    /* Картичка на спомен */
    mem_delete_title:         "Изтрий спомена",
    mem_delete_confirm:       "Да се изтрие „{title}“?",
    mem_importance:           "Важност",
    mem_just_now:             "току-що",
    mem_min_ago:              "преди {n} мин",
    mem_hour_ago:             "преди {n} ч",
    mem_day_ago:              "преди {n} дни",

    /* Чат и поле за въвеждане */
    chat_placeholder:         "Питайте нещо — или кажете „сканирай моя проект в ~/…“",
    chat_send_title:          "Изпрати ({key}+Enter)",
    chat_stop_title:          "Спри генерирането",
    chat_attach_title:        "Прикачи файл или изображение",
    chat_input_hint_html:     "{key}↵ за изпращане &nbsp;·&nbsp; Shift↵ за нов ред",
    chat_input_thinking:      "Aperio мисли…",
    chat_input_warning:       "Вашият AI агент не е всемогъщ. Не разчитайте сляпо на отговора!",
    chat_thinking_label:      "мисля…",
    chat_loading_label:       "зареждам…",
    chat_uploaded_files:      "Качени са {n} файла",
    chat_chars:               "{n} знака",
    chat_attach_remove:       "Премахни",

    /* Динамични UI низове */
    msg_preparing_answer:     "✦ подготвям отговор…",
    msg_reasoning_done:       "готово",
    msg_reasoning_header:     "🧠 Разсъждение",
    msg_reasoning_flat:       "✍️ Разсъждение",
    msg_streaming:            "поточно…",

    /* Начален контекстен банер */
    startup_tokens_from:      "{n} токена предварително заредени от",
    startup_memory_one:       "1 спомен",
    startup_memory_many:      "{n} спомена",
    startup_skill_one:        "1 умение",
    startup_skill_many:       "{n} умения",
    startup_tool_one:         "1 инструмент",
    startup_tool_many:        "{n} инструмента",

    /* Индикатори за инструменти */
    tool_recall:              "Търсене в спомените…",
    tool_remember:            "Запазване на спомен…",
    tool_forget:              "Изтриване на спомен…",
    tool_update_memory:       "Обновяване на спомен…",
    tool_backfill_embeddings: "Генериране на влагания…",
    tool_deduplicate_memories:"Проверка за дубликати…",
    tool_read_file:           "Четене на файл…",
    tool_scan_project:        "Сканиране на проекта…",
    tool_fetch_url:           "Зареждане на URL…",
    tool_generic:             "Използвам {name}…",

    /* Предложени спомени */
    sug_title:                "✦ Предложения за спомени",
    sug_save_all:             "Запази всички",
    sug_skip:                 "Пропусни",
    sug_save_n:               "Запази {n}",

    /* История на сесиите */
    sessions_title:           "История",
    sessions_select:          "Избор",
    sessions_cancel:          "Отказ",
    sessions_count_one:       "1 избран",
    sessions_count_many:      "{n} избрани",
    sessions_bulk_delete:     "Изтрий избраните",
    sessions_loading:         "Зареждам…",
    sessions_empty_html:      "Все още няма минали сесии.<br>Разговорите се пазят при затваряне на раздела.",
    sessions_load_failed:     "Неуспешно зареждане на сесии.",
    sessions_summaries:       "Резюмета",
    sessions_resume:          "Възстанови",
    sessions_no_summaries:    "Все още няма резюмета за тази сесия.",
    sessions_summary_meta:    "{time} · {n} съобщения в точката",
    sessions_resumed_html:    "<i class=\"bi bi-arrow-counterclockwise\"></i> Възстановена: <strong>{title}</strong>",
    sessions_dismiss:         "Затвори",
    sessions_paths_restored:  "<i class=\"bi bi-folder-check\"></i> Папките са възстановени от предишна сесия",
    sessions_summary_one:     "резюме",
    sessions_summary_many:    "резюмета",
    sessions_in_progress:     "в процес",
    sessions_delete_one:      "Да се изтрие сесия „{title}“?\nТова не може да се отмени.",
    sessions_delete_many:     "Да се изтрият {n} сесии?\nТова не може да се отмени.",
    sessions_delete_failed:   "Неуспешно изтриване на сесия: {error}",
    sessions_delete_n_failed: "{n} сесии не можаха да бъдат изтрити.",
    sessions_deleting:        "Изтривам…",
    sessions_loading_short:   "Зареждам…",
    sessions_untitled:        "Без заглавие",

    /* Прозорец „Папки“ */
    paths_title:              "Разрешени папки",
    paths_read_label:         "Папки за четене",
    paths_read_hint:          "Папки, от които AI може да чете файлове",
    paths_write_label:        "Папки за запис",
    paths_write_hint:         "Папки, в които AI може да записва файлове",
    paths_pick_title:         "Избор на папка (отваря Finder)",
    paths_input_placeholder:  "/Users/you/your-project",
    paths_session_note_html:  "<i class=\"bi bi-info-circle\"></i> Промените важат само за тази сесия — не се записват на диск.",
    paths_cancel:             "Отказ",
    paths_apply:              "Приложи",
    paths_applying:           "Прилагам…",
    paths_applied:            "Приложено!",
    paths_apply_failed:       "Неуспешно прилагане на папките: {error}",
    paths_empty:              "Няма зададени папки",
    paths_remove_title:       "Премахни",

    /* Преглед на спомен */
    preview_close:            "Затвори",

    /* Импорт / Експорт */
    export_confirm:           "Aperio ще експортира {n} спомени в JSON файл?",
    import_parse_failed:      "Файлът не може да се прочете — уверете се, че е валиден Aperio JSON експорт.",
    import_invalid_array:     "Файлът не съдържа валиден масив от спомени.",
    import_confirm_one:       "Да се импортира {n} спомен от „{file}“?",
    import_confirm_many:      "Да се импортират {n} спомена от „{file}“?",
    import_done_one:          "Импортиран е {n} спомен.",
    import_done_many:         "Импортирани са {n} спомена.",
    import_done_with_errors:  "Импортирани са {n} спомена. {e} са пропуснати.",
    import_error:             "Грешка при импорт: {error}",

    /* Контекст */
    ctx_warn:                 "Контекстът е {pct}% пълен — стари съобщения скоро ще бъдат премахнати.",
    ctx_trimmed:              "Стари съобщения бяха премахнати, за да се поберат в контекста ({pct}% пълен).",
    ctx_summarize:            "Резюмирай",
    ctx_dismiss:              "Затвори",
    ctx_summarize_failed:     "⚠ Не можах да резюмирам: {reason}",
    ctx_summarize_no_save:    "Резюмето е генерирано, но не можа да се запише в паметта — ще бъде загубено при опресняване.",
    ctx_suggestions_saved_one:  "✓ 1 предложение записано в паметта",
    ctx_suggestions_saved_many: "✓ {n} предложения записани в паметта",

    /* Първоначална настройка */
    setup_page_title:         "Aperio — Настройка",
    setup_intro_h1:           "Еднократна настройка",
    setup_intro_p_html:       "Инсталиране на зависимости — случва се само веднъж.<br>Следващите стартирания са моментални.",
    setup_starting:           "Стартирам…",
    setup_step_of:            "Стъпка {n} от {total}",
    setup_all_done:           "Готово",
    setup_done_banner:        "Настройката е завършена — Aperio е готов.",
    setup_open_aperio:        "Отвори Aperio",
    setup_error_default:      "Настройката не успя. Виж bootstrap.log за подробности.",
    setup_error_prefix:       "Настройката не успя: {msg}",
    setup_step_node:          "Node.js и npm",
    setup_step_deps:          "Зависимости",
    setup_step_ollama:        "Ollama",
    setup_step_model:         "AI модел",
    setup_step_lancedb:       "LanceDB и влагания",
    setup_badge_idle:         "чакане",
    setup_badge_running:      "изпълнение…",
    setup_badge_done:         "готово",
    setup_badge_skipped:      "пропуснато",
    setup_badge_error:        "грешка",
    setup_detail_waiting:     "Чакам…",
  },

  /* Scaffolds — empty objects fall back to English.
     Add keys here to translate. The language switcher shows them
     all immediately, and the AI replies in the chosen language
     even before the chrome is translated. */
  de: {}, fr: {}, es: {}, it: {}, pt: {}, nl: {}, pl: {}, ro: {},
  el: {}, sv: {}, da: {}, fi: {}, cs: {}, sk: {}, sl: {}, hr: {},
  hu: {}, et: {}, lv: {}, lt: {}, mt: {}, ga: {},
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
  // Priority: explicit URL ?lang=xx → cookie → server-injected default → localStorage → navigator → "en"
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("lang");
  if (fromUrl && SUPPORTED_LANGS.includes(fromUrl)) return fromUrl;

  const fromCookie = readCookie(I18N_COOKIE_KEY);
  if (fromCookie && SUPPORTED_LANGS.includes(fromCookie)) return fromCookie;

  // Server may inject a detected default before this script runs
  if (typeof window.__APERIO_LANG__ === "string" && SUPPORTED_LANGS.includes(window.__APERIO_LANG__)) {
    return window.__APERIO_LANG__;
  }

  const fromStorage = localStorage.getItem(I18N_STORAGE_KEY);
  if (fromStorage && SUPPORTED_LANGS.includes(fromStorage)) return fromStorage;

  // navigator.languages: ["en-GB", "en", "bg"] → match first supported
  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language || "en"];
  for (const tag of candidates) {
    const lower = String(tag).toLowerCase();
    const base = lower.split("-")[0];
    if (SUPPORTED_LANGS.includes(base)) return base;
  }

  return "en";
}

let currentLang = pickInitialLang();

function interpolate(str, params) {
  if (!params) return str;
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
}

function t(key, params) {
  const dict = TRANSLATIONS[currentLang] || {};
  const fallback = TRANSLATIONS.en[key];
  const raw = dict[key] != null ? dict[key] : (fallback != null ? fallback : key);
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

function setLang(lang) {
  if (!SUPPORTED_LANGS.includes(lang) || lang === currentLang) return;
  currentLang = lang;
  localStorage.setItem(I18N_STORAGE_KEY, lang);
  writeCookie(I18N_COOKIE_KEY, lang);
  applyTranslations();
  document.dispatchEvent(new CustomEvent("aperio:lang-changed", { detail: { lang } }));
}

/* ── Boot: apply translations as soon as the DOM is parsed ───────────────── */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => applyTranslations());
} else {
  applyTranslations();
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

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
  zh: { flag: "🇨🇳", name: "中文",       englishName: "Chinese" },
  ja: { flag: "🇯🇵", name: "日本語",     englishName: "Japanese" },
};

const SUPPORTED_LANGS = Object.keys(LOCALE_META);

/* ── Translations — en is bundled inline as the immediate fallback ───────── */
const TRANSLATIONS = {
  en: {
    page_title:               "Aperio",
    title_thinking:           "● Aperio is busy",

    nav_toggle_sidebar_show:  "Show sidebar ({key}B)",
    nav_toggle_sidebar_hide:  "Hide sidebar ({key}B)",
    nav_chats:                "💬 chats",
    nav_chats_plain:          "Chats",
    nav_settings_plain:       "Settings",
    nav_settings_title:       "Settings",
    nav_sound_title:          "Voice responses",
    nav_ambient_title:        "Ambient background",
    nav_ambient_auto:         "Auto",
    nav_ambient_on:           "On",
    nav_ambient_off:          "Off",
    nav_theme_title:          "Theme",
    nav_power_title:          "Power — restart or quit Aperio",
    nav_power_restart:        "Restart server",
    nav_power_quit:           "Quit Aperio",
    power_quit_confirm:       "Quit Aperio? The server will stop and this tab will no longer work until you start it again.",
    power_quit_supervised:    "Aperio is managed by a supervisor (Docker, PM2 or systemd), which would restart it right away. Stop it from the supervisor instead.",
    power_stopped_title:      "Aperio has stopped.",
    power_stopped_msg:        "You can close this tab.",
    power_restart_confirm:    "Restart Aperio now? The server will stop and come back in a few seconds. Any in-progress chat or running agent will be interrupted.",
    nav_langmap_title:        "Language — pick on the map",
    langmap_heading:          "Choose your language",
    langmap_count:            "{n} languages · {m} on the way",
    langmap_search:           "Search languages…",
    langmap_available:        "Available",
    langmap_soon:             "Coming soon",
    langmap_not_yet:          "not translated yet",
    langmap_soon_hint:        "coming soon",
    langmap_view_europe:      "Europe",
    langmap_view_world:       "World",
    langmap_hint:             "drag to pan · scroll to zoom",
    langmap_legend_available: "available",
    langmap_legend_not:       "not yet",
    langmap_foot:             "Don't see yours? Aperio's agent understands you anyway — just write in any language.",
    langmap_switched:         "Language switched to {name}",
    nav_chats_title:          "Conversation history",
    nav_codegraph_title:      "Code graph",
    nav_memories_title:       "Memories — search your saved memories",
    nav_reasoning_title:      "Enable reasoning",
    nav_reasoning_label:      "reasoning",
    nav_reasoning_on:         "on",
    nav_reasoning_off:        "off",
    nav_model_title:          "AI model",
    nav_model_guide:          "Not sure which to pick? Model guide →",
    nav_theme_light:          "Light",
    nav_theme_dark:           "Dark",
    nav_theme_aurora:         "Aurora",
    nav_theme_system:         "System",
    nav_fontsize_title:       "Text size",

    status_connecting:        "connecting…",
    status_connected:         "connected",
    status_reconnected:       "reconnected",
    status_disconnected:      "disconnected",
    status_busy:              "busy",
    status_thinking:          "thinking…",
    status_typing:            "typing…",
    status_loading:           "loading…",
    status_model_downloading:    "downloading {model} — {got} GB so far…",
    status_model_downloading_of: "downloading {model} — {got} of {total} GB ({pct}%)",
    status_model_loading:        "loading {model} into memory…",

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
    chat_input_thinking:      "Aperio is busy…",
    chat_input_warning:       "Your AI agent is not almighty. Do not trust the output blindly!",
    chat_thinking_label:      "thinking…",
    chat_loading_label:       "loading…",
    chat_uploaded_files:      "Uploaded {n} file(s)",
    chat_chars:               "{n} chars",
    chat_attach_remove:       "Remove",

    stats_with_thinking:      "🪙 {total} tokens → ✍️ {answer} response · 🧠 +{thinking} thinking · 🚙 speed: {speed} tok/s · ⏱️ completed: {sec}",
    stats_plain:              "🪙 {answer} tokens · 🚙 speed: {speed} tok/s · ⏱️ completed: {sec}",
    stats_context_in:         "📥 {n} context in",
    chip_tokens:              " ~{n} tok",

    choice_caption_pick:      "Tap an option to reply",
    choice_caption_clarify:   "Tap a topic to start your answer — edit it, then send",
    chat_suggest_hint:        "Press Tab ↹ or → to use this suggestion",

    msg_preparing_answer:     "✦ preparing answer…",
    msg_reasoning_done:       "done",
    msg_reasoning_header:     "🧠 Reasoning",
    msg_reasoning_flat:       "✍️ Reasoning",
    msg_streaming:            "streaming…",

    startup_tokens_from:      "{n} tokens at startup",
    startup_tokens_est:       "~{n} tokens at startup (estimate)",
    startup_memory_one:       "1 memory",
    startup_memory_many:      "{n} memories",
    startup_skill_one:        "1 skill",
    startup_skill_many:       "{n} skills",
    startup_tool_one:         "1 tool",
    startup_tool_many:        "{n} tools",
    startup_bd_toggle:        "what's this?",
    startup_bd_title:         "What's in the startup prompt:",
    startup_bd_identity:      "Identity (whoami.md)",
    startup_bd_skill_named:   "Always-on skill: {name}",
    startup_bd_memory_pointer: "Memory index (recall on demand)",
    startup_bd_tools:         "Tool schemas",
    startup_bd_other:         "Conversation scaffolding",
    startup_bd_note:          "Skills & tool schemas are re-sent every turn — LLM APIs are stateless, so this is the cost of context, not duplication.",

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
    tool_web_search:          "Searching the web…",
    tool_write_file:          "Writing file…",
    tool_edit_file:           "Editing file…",
    tool_append_file:         "Appending to file…",
    tool_syntax_check:        "Checking syntax…",
    tool_run_node_script:     "Running script…",
    tool_generate_xlsx:       "Generating spreadsheet…",
    tool_wiki_write:          "Writing wiki article…",
    tool_wiki_get:            "Fetching wiki article…",
    tool_wiki_search:         "Searching the wiki…",
    tool_wiki_list:           "Listing wiki articles…",
    tool_generic:             "Using {name}…",
    skills_chip_label:        "Skills",
    skills_core_label:        "core",
    skills_always_badge:      "always-on",
    skills_more:              "more…",
    skills_load_error:        "Could not load skill.",
    skills_panel_one_shot_label: "use on next prompt",
    skills_panel_one_shot_title: "Include this skill in your next message only — the box unchecks itself after sending. Unchecked: automatic skill matching decides.",
    skills_panel_nav_title:    "Skills — view, edit, create and toggle your agent's skills",
    skills_panel_label:        "Skills",
    skills_panel_search_ph:    "Search skills…",
    skills_panel_new_btn:      "New skill",
    skills_panel_load_failed:  "Couldn't load skills: {error}",
    skills_panel_empty_filtered: "No matching skills.",
    skills_panel_empty_none:  "No skills indexed.",
    skills_panel_badge_customized: "customized",
    skills_panel_badge_yours: "yours",
    skills_panel_badge_off:   "off",
    skills_panel_switch_title:"Inject this skill on every turn",
    skills_panel_edit_title:  "Edit",
    skills_panel_restore_title: "Restore the shipped default",
    skills_panel_remove_title:"Remove",
    skills_panel_disable_confirm: "Disable \"{name}\"? It's a built-in skill, so it will be hidden from your agent but can be restored later.",
    skills_panel_delete_confirm:  "Delete \"{name}\"? This permanently removes your skill.",
    skills_panel_remove_failed:   "Couldn't remove skill: {error}",
    skills_panel_reset_confirm:   "Restore \"{name}\" to its built-in default? Your changes will be discarded.",
    skills_panel_reset_failed:    "Couldn't restore skill: {error}",
    skills_panel_update_failed:   "Couldn't update skill: {error}",
    skills_panel_open_failed:     "Couldn't open skill: {error}",
    skills_panel_new_title:   "New skill",
    skills_panel_close_title: "Close (Esc)",
    skills_panel_field_name:  "Name",
    skills_panel_name_ph:     "my-skill",
    skills_panel_name_hint:   "Lowercase letters, numbers and hyphens. Can't be changed after creation.",
    skills_panel_field_desc:  "Description",
    skills_panel_desc_ph:     "One line: what this skill is for",
    skills_panel_field_keywords: "Keywords",
    skills_panel_keywords_ph: "words that should trigger this skill (space-separated)",
    skills_panel_field_load:  "When to load",
    skills_panel_load_on_demand: "On demand — only when the request matches",
    skills_panel_load_always: "Always on — injected every turn",
    skills_panel_load_never:  "Off — never used",
    skills_panel_field_body:  "Instructions",
    skills_panel_body_ph:     "Write the skill instructions in Markdown…",
    skills_panel_cancel:      "Cancel",
    skills_panel_save:        "Save",
    tool_card_running:        "running…",
    tool_reading_result:      "reading result…",

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

    paths_allowed_label:      "Allowed folders",
    paths_allowed_hint:       "Folders the AI can read and edit. Generated files (pptx, xlsx) go to the session workspace.",
    paths_pick_title:         "Browse for folder (opens Finder)",
    paths_input_placeholder:  "/Users/you/your-project",
    paths_saved_note_html:    "<i class=\"bi bi-hdd\"></i> Saved across sessions.",
    paths_apply:              "Save",
    paths_applying:           "Saving…",
    paths_applied:            "Saved!",
    paths_empty:              "No folders configured",
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
    export_error:             "Export error: {error}",
    export_confirm_full:      "Aperio will export {m} memories and {w} wiki articles?",
    import_confirm_full:      "Import {m} memories and {w} wiki articles from \"{file}\"?",
    import_done_memories:     "Imported {n} memories.",
    import_done_wiki:         "Imported {n} wiki articles.",
    import_done_self_memories:"Imported {n} self memories.",
    import_skipped:           "{m} memories and {w} wiki articles skipped (already exist).",

    ctx_warn:                 "Context is {pct}% full — older messages will be dropped soon.",
    ctx_trimmed:              "Older messages were dropped to fit context ({pct}% full).",
    ctx_summarize:            "Summarize",
    ctx_dismiss:              "Dismiss",
    ctx_capacity_tip:         "{pct}% of what your machine's RAM can hold — the window size Aperio auto-configured for your hardware.",
    ctx_summarize_failed:     "⚠ Could not summarize: {reason}",
    ctx_summarize_no_save:    "Summary generated but could not be saved to memory — it will be lost on refresh.",
    ctx_summarize_ok:         "✓ Conversation summarized and saved to memory.",
    ctx_handoff:              "Context at {pct}% — handoff suggested.",
    ctx_handoff_run:          "Run handoff",
    ctx_suggestions_saved_one:  "✓ 1 suggestion saved to memory",
    ctx_suggestions_saved_many: "✓ {n} suggestions saved to memory",

    discuss_button_label:     "Discuss",
    discuss_button_tooltip:   "Two agents will cross-review answers",

    plus_btn_title:           "Attach or more actions",
    plus_menu_attach_title:   "Attach files",
    plus_menu_attach_desc:    "Images, PDFs, code — anything the model should look at.",
    plus_menu_branch_title:   "Branch conversation",
    plus_menu_branch_desc:    "Start a new conversation with context from this one. Both conversations stay in Sessions.",
    branch_button_label:      "Branch",
    branch_button_tooltip:    "Start a new conversation with context from this one. This conversation stays in Sessions.",
    branch_card_title:        "Start a new branch?",
    branch_card_body:         "This conversation stays saved in Sessions. Aperio opens a new conversation and carries over the latest summary, or excerpts from the last four messages if no summary exists. New replies appear only in the new conversation.",
    branch_card_go:           "Start new branch",
    branch_card_stay:         "Stay here",
    branch_created:           "↳ Branched:",
    sessions_branched_from:   "branched",
    roundtable_phase_answer:        "answering",
    roundtable_phase_review:        "reviewing A's answer",
    roundtable_phase_revise:        "revising in response to B",
    roundtable_phase_rereview:      "re-reviewing A's revision",
    roundtable_phase_manifesto:     "writing manifesto",
    roundtable_phase_status:        "{model} · {action}…",
    roundtable_consensus_label:     "Consensus",
    roundtable_no_consensus_banner: "No consensus after {n} rounds",
    roundtable_no_consensus_attribution: "Aperio · {model} presenting both positions",
    roundtable_position_a:          "Agent A's position",
    roundtable_position_b:          "Agent B's position",
    roundtable_error_title:         "Agent {agent} ({model}) failed while {phase}",
    discuss_summary_title:          "Use this as the topic for the two agents?",
    discuss_use_btn:                "Use this",
    discuss_skip_btn:               "No, skip",
    discuss_ack_note:               "Topic received — I'll weigh in after your next prompt.",
    discuss_staged_note:            "The summary will be fed to both models with your next prompt.",
    discuss_declined_note:          "OK. You can now prompt the models.",
    discuss_download_btn:           "Download",

    setup_page_title:         "Aperio — Setup",
    setup_intro_h1:           "One-time setup",
    setup_intro_p_html:       "Installing dependencies — this only happens once.<br>Future starts are instant.",
    setup_starting:           "Starting…",
    setup_step_of:            "Step {n} of {total}",
    setup_all_done:           "All done",
    setup_done_banner:        "Setup complete — Aperio is ready.",
    setup_open_aperio:        "Open Aperio",
    setup_starting_app:       "Starting Aperio…",
    setup_help_link:          "What was installed on my computer? →",
    setup_error_default:      "Setup failed. Check bootstrap.log for details.",
    setup_error_prefix:       "Setup failed: {msg}",
    setup_file_guard_title:   "Please start Aperio with its launcher",
    setup_file_guard_body:    "This page needs Aperio's engine running. Opening the file directly won't work. Close this tab and start Aperio from the Aperio folder: double-click START.bat on Windows, or run bash START.sh on macOS / Linux. Your browser will open the setup automatically.",
    setup_file_guard_url:     "Already running? Open",
    setup_step_node:          "Node.js & npm",
    setup_step_deps:          "Dependencies",
    setup_step_engine:        "AI Engine",
    setup_step_model:         "AI Model",
    setup_step_sqlite:       "SQLite & Embeddings",
    setup_badge_idle:         "waiting",
    setup_badge_running:      "running…",
    setup_badge_done:         "done",
    setup_badge_skipped:      "ready",
    setup_badge_error:        "error",
    setup_detail_waiting:     "Waiting…",

    wiz_welcome_h1:           "Welcome to Aperio",
    wiz_welcome_p_html:       "How would you like to run the AI? You can change this later in <strong>Configuration</strong> panel.",
    wiz_cloud_title:          "Use a cloud AI",
    wiz_cloud_sub:            "Fastest to start — just paste one API key. (Anthropic or DeepSeek)",
    wiz_local_title:          "Run locally — free & private",
    wiz_local_sub:            "No key, nothing leaves your machine. We'll pick a model that fits your computer.",
    wiz_provider_label:       "Provider",
    wiz_key_label:            "API key",
    wiz_key_placeholder:      "Paste your API key",
    wiz_key_help:             "Where do I get a key? ↗",
    wiz_back:                 "← Back",
    wiz_continue:             "Continue",
    wiz_install_continue:     "Install & continue",
    wiz_checking:             "Checking your machine…",
    wiz_ram:                  "RAM",
    wiz_disk:                 "disk",
    wiz_recommended:          "Recommended model:",
    wiz_choose_installed:     "Choose an installed model.",
    wiz_download:             "(~{n} GB download)",
    wiz_disk_warn:            "⚠ Low on disk — the download may not fit.",
    wiz_specs_unknown:        "unknown",
    wiz_specs_failed:         "Couldn't detect your hardware — we'll set you up with {model}, a small model that runs almost anywhere. You can change this later.",
    wiz_submit_failed:        "Setup failed — please try again.",
    wiz_network_failed:       "Couldn't reach the server — please try again.",

    agent_greeting:           "Greet me warmly in one or two short sentences, as yourself. You may briefly nod to what you already remember about me, but don't list memories or use any tools.",
    agent_greeting_text:      "Hi! How can I help you today?",
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

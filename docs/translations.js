/**
 * translations.js
 * Aperio i18n — English (en) & Bulgarian (bg)
 *
 * Usage in HTML:  data-i18n="key"
 * Usage in JS:    t('key')
 *
 * Keys that contain HTML (links, <br>, <strong> …) use the
 * data-i18n-html attribute on the element so innerHTML is used
 * instead of textContent.
 */

const TRANSLATIONS = {
  en: {
    /* ── Page meta ─────────────────────────────── */
    page_title: "Aperio | Self-Hosted AI Memory Layer & MCP Server",

    /* ── Navbar ────────────────────────────────── */
    nav_features:     "Features",
    nav_stack:        "Stack",
    nav_tools:        "Tools",
    nav_team:         "Team",
    nav_build:        "Build",
    nav_webui:        "Web UI",
    nav_setup:        "Setup",
    nav_aperio_lite:  "Aperio-lite",
    nav_github:       "GitHub",

    /* ── Hero ──────────────────────────────────── */
    hero_eyebrow:     "Open Source · Self-Hosted · Privacy-First · Local by Default",
    hero_h1_line1:    "One brain.",
    hero_h1_line2:    "Every agent.",
    hero_h1_line3:    "Nothing forgotten.",
    hero_lead:        "A self-hosted personal memory layer for AI agents — built on Postgres, pgvector and MCP.<br>Runs 100% local by default. No API keys. No cloud dependency. Your data never leaves your machine.",
    hero_not_dev:     "Not a developer?",
    hero_try_lite:    "✦ Try Aperio-lite",
    hero_no_terminal: "— double-click and go, no terminal needed.",
    hero_dl_dev:      "Download Aperio-dev",
    hero_dl_lite:     "Download Aperio-lite",
    hero_github:      "View on GitHub",

    /* ── Stats bar ─────────────────────────────── */
    stat_mcp_tools:     "MCP Tools",
    stat_memory_types:  "Memory Types",
    stat_api_keys:      "API Keys Required",
    stat_vendor_lock:   "Vendor Lock-in",

    /* ── Features ──────────────────────────────── */
    features_eyebrow: "Features",
    features_h2:      "Everything you need.<br>Nothing you don't.",
    features_lead:    "Built for developers who want AI that actually knows them. Without giving up their data or their infrastructure.",

    feat_memory_title:  "Persistent Memory",
    feat_memory_desc:   "Memories survive every conversation, every tool, every session. 7 structured types keep things organized — facts, decisions, solutions and more.",
    feat_search_title:  "Semantic Search",
    feat_search_desc:   "Powered by pgvector + local embeddings (mxbai-embed-large). Ask about your projects and get results matched by meaning, not keywords. Voyage AI optional.",
    feat_mcp_title:     "MCP Native",
    feat_mcp_desc:      "One brain shared across every agent. Claude, Cursor, Windsurf — all connect to the same Postgres database through the MCP protocol.",
    feat_stream_title:  "Real-time Streaming",
    feat_stream_desc:   "Responses stream token by token via WebSocket. Live code rendering, markdown on completion, smart auto-scroll. No waiting.",
    feat_local_title:   "Local by Default",
    feat_local_desc:    "Runs fully on your machine with Ollama — free, private, offline-capable. Switch to Claude with one env variable when you need more power.",
    feat_dedup_title:   "Auto Deduplication",
    feat_dedup_desc:    "Background job finds near-duplicate memories every 10 minutes using cosine similarity. Dry-run by default — you stay in control.",
    feat_reason_title:  "Reasoning Models",
    feat_reason_desc:   "Native support for thinking models — qwen3, deepseek-r1. A collapsible reasoning bubble shows the model's thought process live. Toggle it on or off anytime.",
    feat_team_title:    "Team Ready",
    feat_team_desc:     "Since you own the database, Aperio scales from personal to shared team brain with two changes — update the system prompt and seed team memories. One brain for the whole team.",

    /* ── Architecture ──────────────────────────── */
    arch_eyebrow: "Architecture",
    arch_h2:      "Simple stack.<br>Serious power.",
    arch_lead:    "One database. One MCP server. Two AI providers. Your brain is just a Postgres table with vectors.",

    /* ── MCP Tools ─────────────────────────────── */
    tools_eyebrow: "MCP Tools",
    tools_h2:      "11 tools. One brain.",
    tools_lead:    "Every tool is available to any MCP-compatible agent (Claude, Cursor, Windsurf).<br>Memory ops, file ops, web fetching.",

    tool_remember_desc:         "Save a memory with auto-generated embedding",
    tool_recall_desc:           "Semantic search with cosine similarity scores",
    tool_update_memory_desc:    "Edit by UUID, regenerates embedding automatically",
    tool_forget_desc:           "Delete a specific memory by UUID",
    tool_backfill_desc:         "Generate missing embeddings in batch",
    tool_dedup_desc:            "Find near-duplicates via cosine similarity",
    tool_read_file_desc:        "Read any file from disk (max 500 lines)",
    tool_write_file_desc:       "Overwrite a file completely with absolute paths",
    tool_append_file_desc:      "Add to end of file with before/after verification",
    tool_scan_project_desc:     "Scan folder tree up to 3 levels deep",
    tool_fetch_url_desc:        "Fetch a URL, strip HTML, truncate to 15k chars",

    /* ── Team ──────────────────────────────────── */
    team_eyebrow: "Team Ready out of the box",
    team_h2_line1: "Personal brain.",
    team_h2_line2: "Or shared team brain.",
    team_h2_line3: "You decide.",
    team_lead:    "Aperio is personal by default.<br>But since <strong>you own the database</strong>, it can become a shared team brain with minimal changes. <br>Every agent, every teammate, every tool — all drawing from the same memory pool.",

    team_feat_decisions_title:  "Shared Decisions",
    team_feat_decisions_desc:   '"We chose Fly.io over Railway in Q3 2024 because of better pricing for always-on workloads."',
    team_feat_project_title:    "Project Knowledge",
    team_feat_project_desc:     '"Project Atlas uses Next.js, PlanetScale, and Stripe. PM is Sara. Lead dev is John."',
    team_feat_onboard_title:    "Onboarding",
    team_feat_onboard_desc:     '"New devs should read X, set up Y, ask Z about access. Deploy on merge to main."',
    team_feat_runbook_title:    "Runbooks",
    team_feat_runbook_desc:     '"When the DB goes down: check pgvector index first, then connection pool, then restart."',
    team_feat_people_title:     "People Context",
    team_feat_people_desc:      '"John handles DevOps, prefers async comms, UTC+2. Sara owns the product roadmap."',
    team_feat_search_title:     "Cross-Project Search",
    team_feat_search_desc:      '"Which projects use Stripe?" · "Who owns the analytics pipeline?" · "What\'s our infra stack?"',

    /* ── Build ─────────────────────────────────── */
    build_eyebrow: "Extensibility",
    build_h2:      "Build on top.<br>Make it yours.",
    build_lead:    "Aperio is a foundation, not a finished product. The source is fully open — fork it, extend it, repurpose it.<br>Here's what you can build on top.",

    build_mem_tag:   "Memory Layer",
    build_mem_title: "Custom Memory Types",
    build_mem_desc:  "The schema is yours to extend. Add new memory types, extra metadata columns, TTL logic, or per-project namespacing. Postgres gives you full flexibility.",
    build_mcp_tag:   "MCP Layer",
    build_mcp_title: "New MCP Tools",
    build_mcp_desc:  "Adding a tool is just a new entry in mcp/index.js. Expose calendar access, email drafting, browser control — any action you want your agents to take.",
    build_ai_tag:    "AI Layer",
    build_ai_title:  "Swap the Embedding Model",
    build_ai_desc:   "mxbai-embed-large via Ollama is the default — zero external calls. Swap in Voyage AI for higher quality, or drop in OpenAI, Cohere, or any provider with a vectors API.",
    build_ui_tag:    "UI Layer",
    build_ui_title:  "Replace or Extend the UI",
    build_ui_desc:   "The web interface is a standalone HTML file with WebSocket. Rip it out and build a VS Code extension, a mobile app, a CLI, a Chrome sidebar — the server API stays the same.",
    build_data_tag:   "Data Layer",
    build_data_title: "Memory Analytics & Insights",
    build_data_desc:  "Query your own memory graph. Build dashboards showing what topics you think about most, decision patterns over time, knowledge gaps, or memory growth by week.",
    build_team_tag:   "Team Layer",
    build_team_title: "Team Shared Memory",
    build_team_desc:  "Since you own the database, Aperio scales from personal to team brain with two changes: update the system prompt to team context, seed team memories in 001_init.sql.",
    build_agent_tag:   "Agent Layer",
    build_agent_title: "Multi-Agent Memory Sharing",
    build_agent_desc:  "Run multiple specialized agents that all share one brain. A research agent stores findings, a coding agent reads context, a writing agent pulls preferences — all from the same database.",

    build_cta_title: "Got an idea? Build it and share it.",
    build_cta_sub:   "Open a PR, open an issue, or fork it and take it somewhere new. Aperio is a starting point.",
    build_fork_btn:  "Fork on GitHub",

    /* ── Comparison ────────────────────────────── */
    compare_eyebrow: "Why Aperio",
    compare_h2:      "Your data. Your rules.",
    compare_lead:    "Commercial memory services are great products.<br>Aperio is a different choice — self-hosted, open source, fully customizable.",

    compare_th_feature: "Feature",
    compare_th_cloud:   "Cloud Services",
    compare_row_ownership:    "Data ownership",
    compare_row_cost:         "Monthly cost",
    compare_row_local_ai:     "Local AI support",
    compare_row_fs_tools:     "File system tools",
    compare_row_source:       "Full source access",
    compare_row_mcp:          "MCP integration",
    compare_row_offline:      "Works offline",
    compare_row_nodev:        "Non-developer friendly",
    compare_row_team:         "Team memory",

    compare_ap_ownership: "100% yours — own Postgres",
    compare_ap_cost:      "Free (self-hosted)",
    compare_ap_local_ai:  "Ollama built-in",
    compare_ap_fs_tools:  "read · write · append",
    compare_ap_source:    "Open source — fork it",
    compare_ap_mcp:       "Native protocol",
    compare_ap_offline:   "With Ollama",
    compare_ap_nodev:     "Aperio-lite — double-click & go",
    compare_ap_team:      "Shared DB — one brain for the team",

    compare_cl_ownership: "Vendor's servers",
    compare_cl_cost:      "$20–100 / month",
    compare_cl_local_ai:  "Cloud only",
    compare_cl_fs_tools:  "Not available",
    compare_cl_source:    "Closed API",
    compare_cl_mcp:       "Varies",
    compare_cl_offline:   "Requires internet",
    compare_cl_nodev:     "Requires dev setup",
    compare_cl_team:      "Varies by plan",

    /* ── Web UI ────────────────────────────────── */
    webui_eyebrow: "Web UI",
    webui_h2:      "See it in action.",
    webui_lead:    "Local AI · persistent memory · streaming responses · 4 themes.",

    /* ── Setup ─────────────────────────────────── */
    setup_eyebrow: "Quick Start",
    setup_h2:      "Up in 5 minutes.",
    setup_lead:    "Node 18+, Docker, and Ollama. No API keys. No cloud. 100% local.<br>Or add Claude + Voyage AI when you need more power.",

    step1_num: "01", step1_title: "Clone & install",
    step2_num: "02", step2_title: "Minimum .env for a fully local setup",
    step3_num: "03", step3_title: "Start database",
    step4_num: "04", step4_title: "Pull the models",
    step5_num: "05", step5_title: "Launch Aperio Web UI",
    step6_num: "06", step6_title: "Use Aperio chat in the terminal",

    /* ── Aperio-lite ───────────────────────────── */
    lite_eyebrow: "Aperio-lite · For non-code humans",
    lite_h2_line1: "Small tool. Big ideas. 🧐",
    lite_h2_line2: "No coding skills required.",
    lite_lead:    "The fastest path to your own private AI.<br>Runs 100% on your machine. No Money. No Cloud. No gibberish.<br><strong>Download → unzip → double-click. That's it.</strong>",

    lite_step_easy_title:   "Easy — macOS / Linux",
    lite_step_win_title:    "Windows & future launches",
    lite_step_uninstall_title: "Uninstall — any OS",

    lite_tagline:     "No Tech skill. No databases. No config files.<br>Just AI that remembers — running quietly on your own machine.",
    lite_dl_btn:      "Download Aperio-lite",
    lite_terminal_btn: "I prefer the terminal",

    /* ── CTA ───────────────────────────────────── */
    cta_tagline:  "Open source · local by default · free forever",
    cta_h2_line1: "Your AI has been",
    cta_h2_line2: "amnesiac?",
    cta_h2_line3: "Fix that today.",
    cta_sub:      "Self-hosted. Takes 5 minutes.",
    cta_star:     "Star on GitHub",
    cta_docs:     "Read the docs",
    cta_origin:   'From Latin <em>aperire</em> — to open, to reveal, to bring into the light ✨',

    /* ── Footer ────────────────────────────────── */
    footer_warning: "⚠️ Warning: Excessive use of AI agents may cause your brain to atrophy, leading to irreversible stupidity. Use responsibly.",
  },

  bg: {
    /* ── Page meta ─────────────────────────────── */
    page_title: "Aperio | Самостоятелен AI слой за памет & MCP сървър",

    /* ── Navbar ────────────────────────────────── */
    nav_features:     "Функции",
    nav_stack:        "Стек",
    nav_tools:        "Инструменти",
    nav_team:         "Екип",
    nav_build:        "Разработка",
    nav_webui:        "Уеб интерфейс",
    nav_setup:        "Инсталация",
    nav_aperio_lite:  "Aperio-lite",
    nav_github:       "GitHub",

    /* ── Hero ──────────────────────────────────── */
    hero_eyebrow:     "Отворен код · Самостоятелен · Поверителност · Локален по подразбиране",
    hero_h1_line1:    "Един мозък.",
    hero_h1_line2:    "Всеки агент.",
    hero_h1_line3:    "Нищо не е забравено.",
    hero_lead:        "Самостоятелен личен слой за памет за AI агенти — изграден върху Postgres, pgvector и MCP.<br>Работи 100% локално по подразбиране. Без API ключове. Без зависимост от облака. Данните ви никога не напускат машината ви.",
    hero_not_dev:     "Не сте разработчик?",
    hero_try_lite:    "✦ Опитайте Aperio-lite",
    hero_no_terminal: "— двоен клик и готово, без терминал.",
    hero_dl_dev:      "Изтеглете Aperio-dev",
    hero_dl_lite:     "Изтеглете Aperio-lite",
    hero_github:      "Вижте в GitHub",

    /* ── Stats bar ─────────────────────────────── */
    stat_mcp_tools:     "MCP инструменти",
    stat_memory_types:  "Типа памет",
    stat_api_keys:      "Необходими API ключове",
    stat_vendor_lock:   "Обвързаност с доставчик",

    /* ── Features ──────────────────────────────── */
    features_eyebrow: "Функции",
    features_h2:      "Всичко необходимо.<br>Нищо излишно.",
    features_lead:    "Създаден за разработчици, които искат AI, който наистина ги познава — без да жертват данните или инфраструктурата си.",

    feat_memory_title:  "Постоянна памет",
    feat_memory_desc:   "Спомените оцеляват при всеки разговор, инструмент и сесия. 7 структурирани типа поддържат ред — факти, решения, намерени решения и още.",
    feat_search_title:  "Семантично търсене",
    feat_search_desc:   "Задвижвано от pgvector + локални влагания (mxbai-embed-large). Питайте за проектите си и получавайте резултати по смисъл, не по ключови думи. Voyage AI е опционален.",
    feat_mcp_title:     "MCP Native",
    feat_mcp_desc:      "Един мозък, споделен между всички агенти. Claude, Cursor, Windsurf — всички се свързват към една и съща Postgres база данни чрез MCP протокола.",
    feat_stream_title:  "Поточно предаване в реално време",
    feat_stream_desc:   "Отговорите се предават токен по токен чрез WebSocket. Рендиране на код на живо, markdown при завършване, умно автоматично превъртане. Без чакане.",
    feat_local_title:   "Локален по подразбиране",
    feat_local_desc:    "Работи изцяло на вашата машина с Ollama — безплатно, поверително, без интернет. Превключете към Claude с една env променлива, когато ви трябва повече мощ.",
    feat_dedup_title:   "Автоматично дедублиране",
    feat_dedup_desc:    "Фонова задача открива почти дублирани спомени на всеки 10 минути чрез косинусово сходство. Dry-run режим по подразбиране — вие сте в контрол.",
    feat_reason_title:  "Модели за разсъждение",
    feat_reason_desc:   "Поддръжка за мислещи модели — qwen3, deepseek-r1. Сгъваем балон показва мисловния процес на модела на живо. Включвайте и изключвайте по всяко време.",
    feat_team_title:    "Готов за екип",
    feat_team_desc:     "Тъй като притежавате базата данни, Aperio се мащабира от личен до споделен екипен мозък с две промени — обновете системния промпт и заредете екипни спомени.",

    /* ── Architecture ──────────────────────────── */
    arch_eyebrow: "Архитектура",
    arch_h2:      "Прост стек.<br>Сериозна мощ.",
    arch_lead:    "Една база данни. Един MCP сървър. Два AI доставчика. Мозъкът ви е просто Postgres таблица с вектори.",

    /* ── MCP Tools ─────────────────────────────── */
    tools_eyebrow: "MCP инструменти",
    tools_h2:      "11 инструмента. Един мозък.",
    tools_lead:    "Всеки инструмент е достъпен за всеки MCP-съвместим агент (Claude, Cursor, Windsurf).<br>Операции с памет, файлове, уеб заявки.",

    tool_remember_desc:         "Запазете спомен с автоматично генерирано влагане",
    tool_recall_desc:           "Семантично търсене с оценки на косинусово сходство",
    tool_update_memory_desc:    "Редактирайте по UUID, влагането се регенерира автоматично",
    tool_forget_desc:           "Изтрийте конкретен спомен по UUID",
    tool_backfill_desc:         "Генерирайте липсващи влагания на партиди",
    tool_dedup_desc:            "Намерете почти дублирани записи чрез косинусово сходство",
    tool_read_file_desc:        "Прочетете файл от диска (макс. 500 реда)",
    tool_write_file_desc:       "Презапишете файл изцяло с абсолютни пътища",
    tool_append_file_desc:      "Добавете в края на файл с проверка преди/след",
    tool_scan_project_desc:     "Сканирайте дърво от папки до 3 нива дълбочина",
    tool_fetch_url_desc:        "Извлечете URL, премахнете HTML, съкратете до 15k символа",

    /* ── Team ──────────────────────────────────── */
    team_eyebrow: "Готов за екип от кутията",
    team_h2_line1: "Личен мозък.",
    team_h2_line2: "Или споделен екипен мозък.",
    team_h2_line3: "Вие решавате.",
    team_lead:    "Aperio е личен по подразбиране.<br>Но тъй като <strong>вие притежавате базата данни</strong>, той може да стане споделен екипен мозък с минимални промени. <br>Всеки агент, всеки член на екипа, всеки инструмент — всички черпят от един и същи пул от памет.",

    team_feat_decisions_title:  "Споделени решения",
    team_feat_decisions_desc:   '"Избрахме Fly.io пред Railway през Q3 2024 заради по-добра цена за постоянно работещи workload-и."',
    team_feat_project_title:    "Знания за проект",
    team_feat_project_desc:     '"Проект Atlas използва Next.js, PlanetScale и Stripe. PM е Сара. Водещ разработчик е Джон."',
    team_feat_onboard_title:    "Въвеждане в работа",
    team_feat_onboard_desc:     '"Новите разработчици трябва да прочетат X, да настроят Y, да попитат Z за достъп. Deploy при merge към main."',
    team_feat_runbook_title:    "Ръководства за инциденти",
    team_feat_runbook_desc:     '"При срив на DB: провери pgvector индекса, после connection pool-а, после рестартирай."',
    team_feat_people_title:     "Контекст за хората",
    team_feat_people_desc:      '"Джон управлява DevOps, предпочита async комуникация, UTC+2. Сара отговаря за продуктовия roadmap."',
    team_feat_search_title:     "Търсене между проекти",
    team_feat_search_desc:      '"Кои проекти използват Stripe?" · "Кой отговаря за analytics pipeline?" · "Какъв е нашият инфра стек?"',

    /* ── Build ─────────────────────────────────── */
    build_eyebrow: "Разширяемост",
    build_h2:      "Надграждайте.<br>Направете го свой.",
    build_lead:    "Aperio е основа, не завършен продукт. Кодът е изцяло отворен — разклонете го, разширете го, преназначете го.<br>Ето какво можете да надградите отгоре.",

    build_mem_tag:   "Слой Памет",
    build_mem_title: "Персонализирани типове памет",
    build_mem_desc:  "Схемата е ваша за разширяване. Добавете нови типове памет, допълнителни колони за метаданни, TTL логика или именни пространства по проект.",
    build_mcp_tag:   "MCP слой",
    build_mcp_title: "Нови MCP инструменти",
    build_mcp_desc:  "Добавянето на инструмент е само нов запис в mcp/index.js. Изложете достъп до календар, изпращане на email, управление на браузър — всяко действие, което искате агентите ви да правят.",
    build_ai_tag:    "AI слой",
    build_ai_title:  "Сменете модела за влагания",
    build_ai_desc:   "mxbai-embed-large чрез Ollama е по подразбиране — нула външни заявки. Сменете с Voyage AI за по-високо качество или интегрирайте OpenAI, Cohere или друг доставчик.",
    build_ui_tag:    "UI слой",
    build_ui_title:  "Заменете или разширете интерфейса",
    build_ui_desc:   "Уеб интерфейсът е самостоятелен HTML файл с WebSocket. Изхвърлете го и изградете VS Code разширение, мобилно приложение, CLI или Chrome sidebar — сървърното API остава същото.",
    build_data_tag:   "Слой Данни",
    build_data_title: "Анализи и прозрения за паметта",
    build_data_desc:  "Правете заявки към собствената си памет. Изграждайте табла с информация за темите, за които мислите най-много, модели на решения, пропуски в знанията или растеж на паметта по седмици.",
    build_team_tag:   "Екипен слой",
    build_team_title: "Споделена екипна памет",
    build_team_desc:  "Тъй като притежавате базата данни, Aperio се мащабира от личен до екипен мозък с две промени: обновете системния промпт и заредете екипни спомени в 001_init.sql.",
    build_agent_tag:   "Агентски слой",
    build_agent_title: "Споделяне на памет между агенти",
    build_agent_desc:  "Пуснете множество специализирани агенти, споделящи един мозък. Агент за изследвания съхранява находки, агент за кодиране чете контекст, агент за писане взима предпочитания — всичко от същата база данни.",

    build_cta_title: "Имате идея? Изградете я и я споделете.",
    build_cta_sub:   "Отворете PR, issue, или разклонете проекта и го отведете на ново място. Aperio е отправна точка.",
    build_fork_btn:  "Разклонете в GitHub",

    /* ── Comparison ────────────────────────────── */
    compare_eyebrow: "Защо Aperio",
    compare_h2:      "Вашите данни. Вашите правила.",
    compare_lead:    "Комерсиалните услуги за памет са страхотни продукти.<br>Aperio е различен избор — самостоятелен, отворен код, напълно персонализируем.",

    compare_th_feature: "Функция",
    compare_th_cloud:   "Облачни услуги",
    compare_row_ownership:    "Собственост на данните",
    compare_row_cost:         "Месечна цена",
    compare_row_local_ai:     "Поддръжка на локален AI",
    compare_row_fs_tools:     "Инструменти за файлова система",
    compare_row_source:       "Пълен достъп до кода",
    compare_row_mcp:          "MCP интеграция",
    compare_row_offline:      "Работи без интернет",
    compare_row_nodev:        "Подходящ за не-разработчици",
    compare_row_team:         "Екипна памет",

    compare_ap_ownership: "100% ваши — собствен Postgres",
    compare_ap_cost:      "Безплатно (самостоятелно)",
    compare_ap_local_ai:  "Ollama вградено",
    compare_ap_fs_tools:  "четене · запис · добавяне",
    compare_ap_source:    "Отворен код — разклонете го",
    compare_ap_mcp:       "Нативен протокол",
    compare_ap_offline:   "С Ollama",
    compare_ap_nodev:     "Aperio-lite — двоен клик и готово",
    compare_ap_team:      "Споделена БД — един мозък за екипа",

    compare_cl_ownership: "Сървърите на доставчика",
    compare_cl_cost:      "$20–100 / месец",
    compare_cl_local_ai:  "Само облак",
    compare_cl_fs_tools:  "Недостъпно",
    compare_cl_source:    "Затворено API",
    compare_cl_mcp:       "Зависи",
    compare_cl_offline:   "Изисква интернет",
    compare_cl_nodev:     "Изисква разработчик",
    compare_cl_team:      "Зависи от плана",

    /* ── Web UI ────────────────────────────────── */
    webui_eyebrow: "Уеб интерфейс",
    webui_h2:      "Вижте го в действие.",
    webui_lead:    "Локален AI · постоянна памет · поточни отговори · 4 теми.",

    /* ── Setup ─────────────────────────────────── */
    setup_eyebrow: "Бърз старт",
    setup_h2:      "Работещо за 5 минути.",
    setup_lead:    "Node 18+, Docker и Ollama. Без API ключове. Без облак. 100% локално.<br>Или добавете Claude + Voyage AI, когато ви трябва повече мощ.",

    step1_num: "01", step1_title: "Клонирайте & инсталирайте",
    step2_num: "02", step2_title: "Минимален .env за напълно локална конфигурация",
    step3_num: "03", step3_title: "Стартирайте базата данни",
    step4_num: "04", step4_title: "Изтеглете моделите",
    step5_num: "05", step5_title: "Стартирайте Aperio Уеб интерфейс",
    step6_num: "06", step6_title: "Използвайте Aperio чат в терминала",

    /* ── Aperio-lite ───────────────────────────── */
    lite_eyebrow: "Aperio-lite · За хора без код",
    lite_h2_line1: "Малък инструмент. Големи идеи. 🧐",
    lite_h2_line2: "Не се изискват умения за програмиране.",
    lite_lead:    "Най-бързият път към вашия личен AI.<br>Работи 100% на вашата машина. Без пари. Без облак. Без сложни неща.<br><strong>Изтеглете → разархивирайте → двоен клик. Това е всичко.</strong>",

    lite_step_easy_title:      "Лесно — macOS / Linux",
    lite_step_win_title:       "Windows и следващи стартирания",
    lite_step_uninstall_title: "Деинсталиране — всяка OS",

    lite_tagline:     "Без технически умения. Без бази данни. Без конфигурационни файлове.<br>Просто AI, който помни — работещ тихо на вашата машина.",
    lite_dl_btn:      "Изтеглете Aperio-lite",
    lite_terminal_btn: "Предпочитам терминала",

    /* ── CTA ───────────────────────────────────── */
    cta_tagline:  "Отворен код · локален по подразбиране · безплатен завинаги",
    cta_h2_line1: "Вашият AI има",
    cta_h2_line2: "амнезия?",
    cta_h2_line3: "Поправете това днес.",
    cta_sub:      "Самостоятелно. Отнема 5 минути.",
    cta_star:     "Дайте звезда в GitHub",
    cta_docs:     "Прочетете документацията",
    cta_origin:   'От латинското <em>aperire</em> — да отвориш, да разкриеш, да изведеш на светлина ✨',

    /* ── Footer ────────────────────────────────── */
    footer_warning: "⚠️ Предупреждение: Прекомерното използване на AI агенти може да атрофира мозъка ви, което води до необратимо заглупяване. Използвайте отговорно.",
  }
};

/* ─────────────────────────────────────────────────────────────
   i18n engine — drop this below the translations object
───────────────────────────────────────────────────────────── */

const I18N_STORAGE_KEY = 'aperio_lang';
let currentLang = localStorage.getItem(I18N_STORAGE_KEY) || 'en';

/** Retrieve a translation string for the active language. */
function t(key) {
  return (TRANSLATIONS[currentLang] && TRANSLATIONS[currentLang][key])
    ?? TRANSLATIONS['en'][key]
    ?? key;
}

/**
 * Apply translations to every element that carries a data-i18n or
 * data-i18n-html attribute.
 *
 *   data-i18n="key"       → sets element.textContent
 *   data-i18n-html="key"  → sets element.innerHTML  (use for strings with tags)
 */
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.title = t('page_title');
  document.documentElement.lang = currentLang;
}

/**
 * Switch the active language, persist the preference, and re-render.
 * @param {string} lang  'en' | 'bg'
 */
function setLang(lang) {
  if (!TRANSLATIONS[lang]) return;
  currentLang = lang;
  localStorage.setItem(I18N_STORAGE_KEY, lang);
  applyTranslations();
  // Update active state on switcher buttons
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
}

// Run once the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  applyTranslations();
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === currentLang);
    btn.addEventListener('click', () => setLang(btn.dataset.lang));
  });
});
// db/memory-seed.js
// Baseline memories seeded when the `memories` table is empty on first boot.
// Purpose: give the user immediate signal in the sidebar + memory table, and
// give the LLM enough context to introduce itself coherently on the first turn.
//
// Source value: 'system' (mirrors the convention used by WIKI_SEED).

export const MEMORY_SEED = [
  {
    type: 'fact',
    title: 'Aperio is a local-first personal AI assistant',
    content: 'Aperio runs entirely on the user\'s machine — no telemetry, no cloud sync. It exposes a chat UI, a memory store (the table in the left sidebar), a code graph, and an LLM-authored wiki built on top of those memories.',
    tags: ['aperio', 'overview'],
    importance: 4,
  },
  {
    type: 'preference',
    title: 'Memories are how Aperio remembers you',
    content: 'Each note in the sidebar is a memory: typed (fact, preference, project, decision, solution, source, person, inference), tagged, and optionally pinned. Pinned memories surface first and bias future replies. Use the table view (top-right button in the sidebar) to browse, search, and edit them in bulk.',
    tags: ['aperio', 'memory', 'usage'],
    importance: 4,
  },
  {
    type: 'preference',
    title: 'Wiki articles are derived, memories are source-of-truth',
    content: 'The Wiki panel shows LLM-authored articles that summarise clusters of related memories. When a source memory changes, the matching wiki article is auto-marked stale and re-generated on the next pass. Treat wiki articles as views; treat memories as the data.',
    tags: ['aperio', 'wiki', 'memory'],
    importance: 3,
  },
  {
    type: 'project',
    title: 'Getting started with Aperio',
    content: 'Try one of: (1) tell the assistant a fact about yourself — it will save a memory; (2) open the Wiki panel to browse seeded articles about Aperio itself; (3) open the Code panel to search symbols in your indexed repos. The Settings panel (gear icon) lets you switch models, themes, and language without touching .env.',
    tags: ['aperio', 'onboarding'],
    importance: 3,
    pinned: 1,
  },
  {
    type: 'source',
    title: 'Where Aperio stores things on disk',
    content: 'SQLite database: .sqlite/aperio.db (see SQLITE_PATH). Sessions: var/sessions/. Uploads: var/uploads/. Skills: skills/<name>/SKILL.md. The .env file at the repo root holds provider keys; everything else is configurable from the Settings panel.',
    tags: ['aperio', 'paths', 'config'],
    importance: 2,
  },
  {
    type: 'fact',
    title: 'Code graph indexes your repo — search symbols, trace callers',
    content: 'Aperio\'s code graph indexes your repository at startup (and on file changes via a watcher). Use code_search to find function/class definitions by name, code_callers to see what calls a symbol, code_callees to trace dependencies, code_context to read a source slice, and code_outline for a structural map. Indexed repos appear in the Code panel sidebar.',
    tags: ['aperio', 'codegraph', 'features'],
    importance: 4,
  },
  {
    type: 'fact',
    title: 'Shell access is guarded — allowlist and operator restrictions',
    content: 'Aperio\'s shell execution is off by default (set APERIO_ENABLE_SHELL=1 to enable). Only allowlisted programs can run: node, npm, git, ls, cat, grep, rg, find, head, tail, python3, soffice, pdftoppm. Shell operators like ;, &&, ||, &, <, >, backticks, and $() are blocked. A single pipe (|) is allowed. run_node_script and run_python_script enforce file extensions (.js/.py) on their targets.',
    tags: ['aperio', 'shell', 'security', 'guardrails'],
    importance: 4,
  },
  {
    type: 'fact',
    title: 'Embeddings power semantic search — transformers by default',
    content: 'Aperio generates vector embeddings for every memory (title + content) and wiki article (title + summary + body). The default provider is HuggingFace Transformers running mixedbread-ai/mxbai-embed-large-v1 locally via ONNX — 1024 dimensions, fully offline, no API key needed. Voyage AI is the cloud alternative. Run backfill_embeddings if any memories are missing their vectors (shown as zero vectors in the store). Changing providers after data exists requires wiping the DB — dimension mismatch is fatal at startup.',
    tags: ['aperio', 'embeddings', 'features', 'vector-search'],
    importance: 4,
  },
  {
    type: 'fact',
    title: 'MCP tools run in a child process over stdio',
    content: 'Aperio launches an MCP (Model Context Protocol) subprocess at startup (node mcp/index.js) that communicates with the main server over stdio transport. All tool execution — memory read/write, wiki management, shell commands, file I/O, web fetching — happens inside this child process, not the main LLM agent loop. This boundary isolates tool side effects from the chat stream and makes the tool execution surface independently auditable. The MCP server registers 22+ tools across six modules: memory, wiki, files, shell, web, and image.',
    tags: ['aperio', 'mcp', 'architecture', 'security'],
    importance: 4,
  },
  {
    type: 'fact',
    title: 'Roundtable enables multi-model discussions',
    content: 'Aperio\'s roundtable feature lets multiple AI models discuss a topic together, each responding in turn. Configure it with ROUNDTABLE_AGENTS=provider:model,provider:model (comma-separated) and ROUNDTABLE_MAX_ROUNDS to cap the conversation length. The models read each other\'s responses and build on them — useful for design reviews, second opinions, and exploring trade-offs from different model perspectives. The feature is opt-in and requires at least two configured agents.',
    tags: ['aperio', 'roundtable', 'features', 'multi-agent'],
    importance: 3,
  },
  {
    type: 'fact',
    title: 'Skills are Markdown prompts — no engine, no weights',
    content: 'Aperio\'s skill system injects SKILL.md files into the LLM system prompt at conversation start. There is no plugin loader, no DSL, no special runtime — a skill is just a markdown file with frontmatter. Skills trigger on (1) direct name match — every word of the skill name appears in the message — or (2) keyword scoring — at least two curated keywords or description words match. Stub skills marked load: never (like coding-examples and memory-learning) are filtered out and never trigger, even on keyword matches. Skills live under skills/<name>/SKILL.md and are hot-reloaded on restart.',
    tags: ['aperio', 'skills', 'features', 'prompts'],
    importance: 4,
  },
  {
    type: 'project',
    title: 'Aperio capability exam — test this model\'s tool use',
    content: 'Aperio ships with an integration exam that tests every tool and skill against a realistic persona dataset. It covers memory recall, wiki authoring, code graph navigation, shell guardrails, skill triggering, and multi-tool chains. To take the exam, the user says "let\'s do the exam" or "run the Aperio exam." When triggered: (1) fetch the canonical exam issue at https://github.com/BaiGanio/aperio/issues/129 — it will instruct you to fetch the latest exam.md from https://raw.githubusercontent.com/BaiGanio/aperio/refs/heads/master/.github/capability-exam/exam.md. (2) Follow the exam\'s §0 to import the fixture dataset, then run drills section by section. (3) Track which tools fire and whether results match the ✅ expectations. For cleanup, the user says "clean up the exam" — recall all memories tagged aperio-exam and forget each one, then delete any scratch/ files. The exam is versioned alongside the codebase; always fetch the issue (and through it, the latest exam.md) rather than relying on local copies.',
    tags: ['aperio', 'exam', 'testing', 'onboarding'],
    importance: 5,
    pinned: 1,
  },
];

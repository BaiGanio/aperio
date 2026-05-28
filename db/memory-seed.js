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
    content: 'SQLite database: var/aperio.db (or sqlite/aperio.db, see SQLITE_PATH). Sessions: var/sessions/. Uploads: var/uploads/. Skills: skills/<name>/SKILL.md. The .env file at the repo root holds provider keys; everything else is configurable from the Settings panel.',
    tags: ['aperio', 'paths', 'config'],
    importance: 2,
  },
];

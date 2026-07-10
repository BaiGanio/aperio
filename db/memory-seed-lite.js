// db/memory-seed-lite.js
// Non-coder starter memories, seeded instead of MEMORY_SEED when the lite
// profile is active (APERIO_LITE=on — the desktop launchers set it). Same
// mechanics as MEMORY_SEED (seeded only when `memories` is empty on first
// boot); different audience: someone who will never open a terminal or .env.
// Focus: working with documents, changing settings from the UI, what the
// installer put on the machine, and learning how AI models differ.
//
// The capability-exam entry is reused from MEMORY_SEED (single source for the
// exam protocol text) — looked up by its 'exam' tag.

import { MEMORY_SEED } from './memory-seed.js';

const examEntry = MEMORY_SEED.find(m => m.tags?.includes('exam'));

export const MEMORY_SEED_LITE = [
  {
    type: 'fact',
    title: 'Aperio is your private AI — everything stays on your computer',
    content: 'Aperio runs entirely on this machine: no account, no subscription, no cloud. The AI model, your conversations, your memories and your documents never leave your computer. It is free to use and works offline once installed. You can change the AI model, the language, and the look from the Settings panel (gear icon) at any time.',
    tags: ['aperio', 'overview', 'privacy'],
    importance: 5,
  },
  {
    type: 'preference',
    title: 'Memories are how Aperio remembers you',
    content: 'Each note in the left sidebar is a memory. Tell the assistant something about yourself or your work and it will offer to save it; saved memories carry over to every future conversation, whichever AI model is running. Pinned memories surface first. Use the table view (top-right button in the sidebar) to browse, search, and edit them.',
    tags: ['aperio', 'memory', 'usage'],
    importance: 5,
  },
  {
    type: 'fact',
    title: 'Aperio can read and work with your documents',
    content: 'Aperio understands PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), plain text, Markdown, email files, and images (photos and scans are read by a local vision model). Attach a file to the chat and ask questions about it, ask for a summary, or ask Aperio to create a new Word or Excel document for you. Whole folders of documents are searchable at once — the document index (docgraph) is on out of the box in the lite setup, watching the allowed folders.',
    tags: ['aperio', 'documents', 'files', 'features'],
    importance: 5,
  },
  {
    type: 'project',
    title: 'Getting started — three easy first steps',
    content: 'Try one of: (1) tell the assistant a fact about yourself — it will save a memory and remember it next time; (2) attach a document (PDF, Word, Excel…) and ask questions about it; (3) open Settings (gear icon) and try a different AI model, language, or theme. Guided tours live at https://baiganio.github.io/aperio and the built-in help page at /help.html explains what was installed and how everything works.',
    tags: ['aperio', 'onboarding'],
    importance: 4,
    pinned: 1,
  },
  {
    type: 'fact',
    title: 'AI models are different — try them like you would try people for a job',
    content: 'Each AI model has its own size, speed, skills, and personality — they are trained differently and are good at different things. Smaller models answer faster and run on modest hardware but are simpler; bigger models reason better but need more memory. Switch models from the model menu in the top bar and compare how they answer the same question. The model guide (linked next to the menu) and the tour pages introduce each one.',
    tags: ['aperio', 'models', 'learning'],
    importance: 4,
  },
  {
    type: 'source',
    title: 'What the installer added to your computer, and where your data lives',
    content: 'The installer added: Node.js (the runtime Aperio runs on — installed user-local, no admin), the llama.cpp engine (runs the AI model — kept inside the Aperio folder under vendor/), one AI model chosen to fit your hardware (several GB), and Aperio itself. Your data stays inside the Aperio folder: the database at .sqlite/aperio.db, logs and uploads under var/. The help page at /help.html has the full list and the uninstall instructions.',
    tags: ['aperio', 'install', 'paths'],
    importance: 4,
  },
  {
    type: 'fact',
    title: 'Starting and stopping Aperio',
    content: 'Day to day, start Aperio from the "Aperio" icon on your Desktop — it opens the browser with no terminal window. On the very first run a terminal window stays open: that window IS Aperio\'s engine, so keep it open while you use the app. Aperio stops itself a few minutes after the last browser tab closes, and you can always stop it with the Quit button (power icon) in the top bar.',
    tags: ['aperio', 'launch', 'usage'],
    importance: 4,
  },
  // Reuse the capability-exam protocol entry as-is (see db/memory-seed.js).
  ...(examEntry ? [examEntry] : []),
];

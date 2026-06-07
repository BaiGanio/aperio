# Plan: Self-Knowledge Prompt + Technical-User Installer

Status: **draft for review** — nothing is wired in yet. Revise, then implement.

## Context

Two ideas were raised:
- **A.** A `curl … | bash` one-liner install for technical users.
- **B.** Seed "what Aperio is / how it works / its tools" knowledge so the model
  wakes up oriented instead of amnesiac, loaded each session, but token-cheap.

Investigation finding: **B's goal is already ~80% built**, spread across:

| Mechanism | File | Role |
|---|---|---|
| Identity prompt (cached) | `id/whoami.md` | The model's persistent "who am I" — behavior, principles, persona. |
| Seeded memories | `db/memory-seed.js` | 5 "about Aperio" notes, seeded only when `memories` is empty on first boot. |
| Seeded wiki | `db/wiki-seed.js` | LLM-authored articles about Aperio. |
| Session preload | `lib/agent/index.js:833` `buildGreeting` | Preloads top-5 memories by importance each session. |

The gap: `whoami.md` covers *how I behave*, but not *what product I'm inside and
what subsystems I can act on*. That orientation is what idea B is really after.

## Decision: where self-knowledge should live

**System prompt, not the memory table.** Rejected the "seed as memories + preload
each session" mechanism because:

1. **Preload budget competition.** Preload is `limit:5, importance DESC` — a
   budget *shared* with the user's real memories. Keeping self-knowledge in it
   means crowding out the user's own context at session start.
2. **Self-defeating.** As the user adds important/pinned memories, the meta-notes
   get pushed out of the top-5 — exactly as they should be for user data. So the
   memory table is a *leaky* home for durable self-knowledge.
3. **Pollution + recurring token cost.** Fills the user's sidebar with system
   content and re-pays tokens every session — the bloat we want to avoid.

The system prompt is static → prompt-cached → paid once per cache window, doesn't
touch the preload budget, doesn't pollute the sidebar.

## Part B — implementation

1. **`id/capabilities.md`** (DRAFTED — see file). A surgical product map: the
   three subsystems (memory store, code graph, wiki) and how they relate. A *map*,
   not a re-listing of tools (tool descriptions already cover the "how"), and no
   overlap with `whoami.md`'s behavioral content.
   - Measured footprint: **~408 tokens** (`char/4`, the app's own estimator),
     **cached**. Revise wording to taste — footprint scales with length.
2. **Wire it in:** add `"capabilities.md"` to the `FILES` array in
   `lib/agent/index.js:160`. One-line change; this is what activates it. Until
   then the file is inert.
3. **Trim `MEMORY_SEED`** (optional): now that orientation lives in the prompt,
   the 5 seeded memories can shrink to pure first-boot *UX signal* for the sidebar
   (e.g. 1–2 notes) rather than trying to teach the model. Revisit after B lands.
4. **Verify:** start a session, confirm the startup breakdown banner's `identity`
   figure rises by ~the measured amount and not more; confirm the model can
   correctly describe its subsystems on turn one without a `recall`.

### Open questions for B
- Keep capabilities as a separate `id/capabilities.md`, or append as a section of
  `whoami.md`? (Separate file = easier to toggle and measure. Leaning separate.)
- Does the persona/verifier variant (`whoami-primary.md`, `whoami-verifier.md`)
  also want the capabilities block, or only the primary agent?

## Part A — one-liner installer (decided design)

**Decision:** no npm publishing. A single `curl … | bash` command clones a
**dedicated, user-ready branch** (clean, no dev clutter) and runs a **hands-off**
install — no further user interaction.

Flow the script runs:
1. Clone the dedicated branch, shallow: `git clone --depth 1 --branch <branch>
   https://github.com/BaiGanio/aperio <target-dir>`. Handle "dir already exists".
2. `npm ci` (or `npm install`) in the target dir.
3. `npm run migrate:sqlite` to create the local DB.
4. Scaffold `.env` from `.env.example` using the **lite defaults** (Ollama +
   SQLite + transformers embeddings) — this path needs **no API keys**, which is
   what makes "no interaction" actually achievable. Don't clobber an existing `.env`.
5. Launch `npm run start:lite` (and optionally open the browser), or stop and
   print the one start command.

### Things that make true "zero interaction" hard (must handle)
- **Node + build toolchain.** `better-sqlite3` and `@huggingface/transformers`
  are native deps. On a bare machine they need Node and a C/C++ toolchain. The
  script must either (a) detect-and-fail with a clear message, or (b) install them
  — which needs `sudo` and therefore *does* prompt. Decide which.
- **Ollama + a model.** The lite path runs on Ollama, which is a separate program
  and needs a model pulled (a large download). The script either installs Ollama
  and pulls a default model (hands-off but heavy), or assumes Ollama is present
  (lighter, but not truly zero-setup). Decide which.
- **Target directory & re-runs.** Pick a default (`~/aperio`), and define behavior
  when it already exists (skip / update / abort).

### Brand note (decided to proceed anyway)
`curl | bash` is in mild tension with Aperio's privacy/security brand. Zero-cost
mitigations to keep: host the script in-repo so it's inspectable, pin the one-liner
to the dedicated branch (not a moving `main`), and optionally publish a checksum.

### Open questions for A
- **Branch name** for the clean user-ready branch? (e.g. `release`, `dist`,
  `stable`.) And what keeps it clean — manual, or a CI job that builds it?
- **Toolchain:** install Node/build-tools/Ollama automatically (heavier, needs
  sudo), or detect-and-instruct?
- **End state:** auto-launch + open browser, or finish and print the start command?

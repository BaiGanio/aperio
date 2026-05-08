# Aperio — Future Work & Roadmap

> **Scope:** an honest, opinionated audit of the current state of the project plus a prioritised roadmap.
> **Snapshot taken on:** 2026-05-08 (branch `master`, package version `0.48.3`).
> **Goal:** turn Aperio from "early-stage, locally usable, nicely architected" into "trustable, scalable, hackable, and *delightful*".

---

## Part 1 — Honest Assessment

### What is genuinely good

These are not things that need touching — they reflect deliberate, mature decisions:

- **Provider-agnostic agent core.** `lib/agent.js` cleanly abstracts over Anthropic, DeepSeek and Ollama via one `runAgentLoop`. Adding a 4th provider is a localised change.
- **Two backends with sensible auto-selection.** `db/index.js` resolves `postgres` vs `lancedb` via `DB_BACKEND` env or Docker probing. Postgres+pgvector for power users, LanceDB for zero-config — a thoughtful split.
- **Local-first embeddings.** Default `transformers` (mxbai-embed-large via ONNX) means semantic search works with no API keys. Voyage stays as a clean upgrade path.
- **MCP server architecture.** The split between `mcp/index.js` (transport + registration) and tool registrars (`memory.js`, `files.js`, `web.js`, `image.js`) is clean and extensible.
- **Bootstrap UX.** `bootstrap.js` + `setup.html` + SSE progress stream is a *real* first-run experience. Most OSS projects ship raw README installation.
- **Path safety guards.** Read/write paths are explicitly separated; `clampToDefaults()` on session restore prevents privilege escalation by tampered session files.
- **Output validation.** `validateOutput.js` is a small but thoughtful XSS-defense + fence-fixing layer. Defence-in-depth even though the frontend escapes too.
- **Idle watchdog.** Ollama auto-shutdown via heartbeat is the kind of polish most local-AI projects skip.
- **Test breadth.** `tests/` has ~28 spec files covering handlers, attachments, helpers, MCP tools, store, skills, workers — that's a real suite, not a token gesture.
- **Skill system.** `loadSkillIndex()` + `matchSkill()` + always-on skills is a nice form of contextual prompt augmentation.
- **CI security stack.** Dependabot + CodeQL + SonarQube + Codacy + Codecov is overkill for a hobby project — in a good way.
- **Session lifecycle.** `finaliseSession()` discards trivial chats, derives titles from summaries, and stores compact resume context. Most chat apps ship empty "Untitled chat" lists.
- **Reasoning adapter pattern.** `lib/workers/reasoning.js` lets thinking-model quirks live in their own module — extensible.
- **Attachment pipeline.** Image/text/PDF/DOCX/PPTX handlers are properly separated. PDF preprocessing for VLM is a nice touch.

### What is wrong, weak, or risky

Listed roughly in order of severity. Many are quick fixes; a few are foundational.

#### 🔴 Correctness / Security (must fix)

1. **`/api/memories` is broken on Postgres.** `lib/routes/api.js:94` calls `store.table.query().limit(10_000).toArray()` — `table` only exists on `LanceDBStore`. In Postgres mode this throws. The export-to-JSON feature in the sidebar is silently broken for half the users. The route should call `store.listAll()` (which both backends implement).
2. **Module-level `streamUsage` is a concurrency landmine.** `lib/agent.js:20` has `let streamUsage = …` at module scope. Two concurrent WebSocket clients streaming at once will clobber each other's token counts. Today it works because dev usage is single-tab; tomorrow this is a bug report you can't reproduce.
3. **Path config is global, not per-connection.** `ALLOWED_READ_PATHS` and `ALLOWED_WRITE_PATHS` are mutated in-place by `updatePaths()`. The "session-scoped paths" UX claim in `paths.js` is a lie — *any* WS client that calls `POST /api/paths` rewrites the array for *every* other open client. Multi-tab use will leak permissions across sessions.
4. **No symlink resolution.** `paths.js` resolves with `path.resolve()` but never `fs.realpath()`. A symlink inside `APERIO_ALLOWED_PATHS_TO_READ` pointing to `/etc/passwd` would pass the prefix check. Same for write paths — a symlink inside the project root could write outside it.
5. **`~` expands to `cwd`, not `$HOME`.** `paths.js:21` does `replace(/^~/, BASE_DIR)` where `BASE_DIR = process.cwd()`. This is the opposite of every other tool. Either honour POSIX `~` (use `os.homedir()`) or strip the support entirely — silent surprise is worse than either.
6. **No authentication on the HTTP server, but README claims it's safe-on-LAN.** The server happily accepts any WS connection and any `/api/*` POST. README acknowledges "do not expose to public internet" but the actual app has no `bind 127.0.0.1` enforcement, no localhost-only middleware, no token. One misconfigured `0.0.0.0` and the box is open. Add a localhost guard *by default* and require explicit opt-in to bind elsewhere.
7. **No request size limits.** `app.use(express.json())` uses Express defaults (100KB). Attachments come over WS so this is fine for chat, but `/api/memories/import` accepts arbitrary JSON — easy DoS.
8. **`SECURITY.md` is fictional.** It lists supported version `2.42.5` while `package.json` is `0.48.3`. The contact email is `security@yourproject.com`. This is worse than no security policy — it tells real reporters to email a non-existent address.
9. **`docker-compose.yml` ships `POSTGRES_PASSWORD: aperio_secret` in plaintext, committed.** Fine for a local-dev quickstart, but combined with the lack of bind-to-localhost it means anyone reading the README gets root on a Postgres instance if a user runs Docker on a public network.
10. **No origin / host check on the WebSocket upgrade.** `server.js:186` mounts `WebSocketServer({ server: httpServer })` with no `verifyClient`. Combined with `0.0.0.0` exposure → cross-site WS hijacking is possible.

#### 🟠 Architecture / Maintainability

11. **`lib/agent.js` is a 440-line god module.** It mixes provider resolution, JSON-schema conversion, token estimation, message trimming, two separate streaming loops, two tool executors, and the final exposed API. Splitting into `providers/`, `streaming/`, `context/`, `tools/` would make each piece tractable.
12. **`public/scripts/message-handler.js` is 953 lines and `public/index.css` is 2079.** No build step, no module system — these grow forever. Even moving to ES modules with `<script type="module">` and splitting per concern would cut diff noise massively.
13. **No type system.** Pure JS with no JSDoc on public boundaries means refactors are guess-and-check. TypeScript with `tsc --noEmit` (or even just `// @ts-check` on key files) would catch the `store.table` bug above on save.
14. **`db/index.js` has dev-only stack-walking left on.** Lines 26-34 grab a stack trace and log the caller filename on every fresh `getStore()` call. Looks like debugging code that shipped.
15. **Schema drift between Postgres and LanceDB.** `LanceDBStore` stores `expires_at` as `""` instead of `NULL`. `tags` is JSON-stringified in LanceDB but a real array in Postgres. There's no shared schema definition — two adapters drift independently.
16. **No migration runner.** `db/migrations/001_init.sql` and `002_pgvector.sql` are run by hand via `docker exec`. Adding column 003 means writing manual instructions every time. Use `node-pg-migrate` or write a 50-line runner that tracks `schema_version`.
17. **Embedding dimension `DIMS = 1024` is hard-coded.** `db/lancedb.js:14`. If anyone swaps to a model with different dimensions, the LanceDB schema is incompatible with no migration path.
18. **MCP server is stdio-only.** No HTTP/SSE transport means remote agents (e.g. Claude Desktop on another machine) can't reach this MCP server. Fine for local but limits the "any MCP-compatible agent" promise.
19. **`getSystemPrompt(userMessage)` matches one skill.** `matchSkill()` returns the first hit; multi-skill scenarios (a message that's both about reasoning and about file IO) lose context.
20. **`buildResumeContext()` injects the resume prompt as a `user` message.** That's an ergonomic hack — the model sees "you are resuming a conversation" as if the user said it. A `system` message or a synthetic assistant ack would be cleaner.
21. **No graceful degradation when embeddings fail.** `generateEmbedding()` returns `null` on failure; insert proceeds without one. Fine, but there's no retry queue and no surfacing — silently un-embedded memories accumulate until the next backfill.
22. **Workflow file count >> code file count.** `.github/workflows/` has 16 yml files (issue claim guard, leaderboard, milestone sync, …). Most of this is community automation around a project with no meaningful community traffic yet. It's overhead before there's a problem to solve. Ruthlessly delete the bot-* workflows until there's a real backlog.
23. **`var/sessions/*.json` is unbounded.** Old sessions are never pruned; trivial sessions are discarded but every other session lives forever. After 6 months of daily use you'll have thousands of files and `listSessions()` reads them all on every page load.
24. **Logging is split between `winston` and `console.*`.** `db/lancedb.js`, `lib/helpers/embeddings.js`, parts of `wsHandler.js` use `console.error/warn`. Either commit to `logger` everywhere or replace it.

#### 🟡 Quality / Polish

25. **No e2e tests.** All tests are unit-level. The end-to-end flow (browser → WS → agent → MCP → store) has no automated coverage. Even one Playwright test that says "send a message, expect a streamed reply" would catch ~80% of integration regressions.
26. **No Dockerfile for the app.** Only Postgres has a compose file. A first-run user has to install Node + npm install + run a script. The "self-hosted" promise would be much stronger with `docker compose up` running everything.
27. **No CHANGELOG.md.** Version bumps happen in `package.json` but there's no per-version note of what changed. With auto-release workflows in `.github/workflows/cd.release.yml` this is mostly free to add.
28. **README claims "12 MCP tools" but the actual count is 13** (memory: 6 + files: 4 + web: 1 + image: 2). Tiny but it's the kind of detail that erodes trust the second a reader counts.
29. **Folder picker is macOS-only** (`osascript`). Linux/Windows users get only the browser fallback. Cross-platform pickers exist (`@electron/remote`, `xdg-portal`).
30. **No memory diff / audit history.** When you `update_memory`, the previous version is gone forever. For "personal memory" this is a surprising data-loss surface — at minimum, append-only history would be reassuring.
31. **`/api/chat` is a half-implemented endpoint.** It only proxies to Ollama, ignores the configured provider, and is unreachable from the UI (which uses WS). Either delete it or make it provider-aware.
32. **Hard-coded English in `to_tsvector('english', …)`.** The repo has multilingual landing pages (`docs/translations.js`) but FTS is anglo-only.
33. **No backups.** A user's "personal memory layer" lives in `./.lancedb/` or in a Docker volume with no documented backup story. This is the *one* thing they'd be devastated to lose.
34. **`bootstrap.js` runs `curl | sh` for nvm and Ollama installers.** It logs the output but a user has zero idea this is happening. The setup screen should at least show "we're about to download X from Y" with a confirm.
35. **`server.js` has no `process.on('uncaughtException')` handler.** A single unhandled rejection inside the WS callback will crash the whole server.

---

## Part 2 — Roadmap

Each section is a prioritised batch. Inside a section, items are listed in suggested order.

### 🥇 Phase 1 — Stop the bleeding (1–2 weeks of focused work)

Do these first. They are correctness and security bugs that affect users *today*, plus the shortest-path fixes that unblock everything else.

1. **Fix `/api/memories` for Postgres.** Replace `store.table.query()…` with a backend-agnostic call. Add a regression test that runs against both backends.
2. **Move `streamUsage` into per-connection state.** Pass it through the agent loop via a context object instead of module scope. Add a stress test with two concurrent WS clients.
3. **Make path config per-WS-connection.** `ALLOWED_READ_PATHS` / `ALLOWED_WRITE_PATHS` should be local to the connection or to a session. Have `wsHandler.js` carry an immutable per-connection paths struct, and let `mcp/tools/files.js` receive guards via `ctx` (not via a shared module). This is also a chance to drop the global mutable arrays entirely.
4. **`fs.realpath` in path guards.** Resolve symlinks before the prefix check. Add tests that prove a symlink to `/etc/passwd` is rejected.
5. **Bind to `127.0.0.1` by default.** Require an explicit `BIND=0.0.0.0` env to expose. Add an origin allowlist for WS upgrades.
6. **Fix `SECURITY.md`.** Replace placeholder email and version. Either link to GitHub Security Advisories only, or set up a real intake address.
7. **Remove dev-only logging in `db/index.js`.** Drop the stack-walking caller-detection block (lines 26-34).
8. **Set explicit body size limits.** `express.json({ limit: '1mb' })` or per-route. Document the limit.
9. **Patch `~` handling.** Either resolve to `os.homedir()` (correct) or remove the `~` rewrite entirely (also correct). Stop the silent surprise.
10. **Add `process.on('uncaughtException' / 'unhandledRejection')` in `server.js`** that logs and continues, rather than crashing the agent loop.

### 🥈 Phase 2 — Foundations for scale (2–4 weeks)

With the leaks plugged, harden the foundations so future features don't keep stepping on the same potholes.

11. **Split `lib/agent.js`.** Target structure:
    - `lib/agent/index.js` — `createAgent()` factory only
    - `lib/agent/providers/{anthropic,ollama,deepseek}.js` — one streaming loop per provider
    - `lib/agent/context.js` — `estimateMsgTokens`, `trimByTokens`, `dropOrphanedToolResults`
    - `lib/agent/tools.js` — `ToolExecutor`, `extractTextToolCall`
    - `lib/agent/schema.js` — `inferZodType`, `zodToJsonSchema`
12. **Adopt `// @ts-check` + JSDoc on `lib/agent/*`, `db/*`, `mcp/tools/*`.** No build step needed; immediate IDE feedback.
13. **Real migration runner.** Track `schema_migrations` table; add a `npm run migrate` script. Will be needed the moment you add column 003.
14. **Unified store schema.** Define memory shape in one place (`db/types.js` exists — flesh it out). Both `PostgresStore` and `LanceDBStore` should serialise identically — same `tags` shape, same `expires_at` semantics (`null`, not `""`).
15. **Make `DIMS` configurable.** Read from env / detect from the embedding model. LanceDB schema must match.
16. **Backups for both backends.** `npm run backup` exports the memories table to a portable JSON file. `npm run restore <file>` reads it back. Document where data lives.
17. **Session pruning.** Sweep `var/sessions/` periodically (or on-demand) — drop sessions older than N days, or cap to M files. Add UI to pin keepers.
18. **End-to-end test (Playwright).** One test that boots the server, sends "hello", asserts streamed text comes back. Run it in CI.
19. **Dockerfile for the whole app.** Multi-stage build, baked Node, optional `MODE=lite` to skip Postgres. `docker compose up` should give a working installation in one command.
20. **Audit and prune `.github/workflows/*`.** Keep CI + release. Move all `bot.*.yml` (issue claim, moderation, leaderboard, etc.) to a separate `community/` repo or feature-flag them off until claim volume justifies them.

### 🥉 Phase 3 — Quality of life (4–8 weeks)

Things that don't change the architecture but make Aperio noticeably nicer.

21. **Memory history / audit log.** Append-only `memory_versions` table; every `update_memory` and `forget` writes a snapshot. Surface "history" on each memory in the sidebar.
22. **Hybrid search (BM25 + vector).** Postgres has FTS, LanceDB has full-text in newer versions. Reciprocal-rank-fusion the two scores. Materially better recall than either alone.
23. **Multi-skill prompting.** Have `matchSkill()` return *all* matches above threshold, not just the first.
24. **Real CHANGELOG.md.** Backfill from git log; `release-please` or `changesets` going forward.
25. **Graceful embedding retries.** Failed embeddings get queued for re-attempt with exponential backoff. Surface the queue state in the UI.
26. **Unify logging.** One `logger`. No `console.log`. ESLint rule to enforce.
27. **CSS modularisation.** Split `public/index.css` per-component into `public/styles/*.css`. Already started with `input-bar.css` etc. — extend it.
28. **Frontend ES modules.** Replace `<script src=…>` chain with `<script type="module">`. No bundler needed for the medium term.
29. **Cross-platform folder picker.** Use the new HTML File System Access API where available; fall back to OS-specific pickers.
30. **i18n for FTS.** Detect language and use the right `to_tsvector` config, or fall back to vector-only for non-English content.

### 🏆 Phase 4 — Earn the trust (ongoing)

Stuff that takes Aperio from "works for the maintainer" to "I'd put my real personal memory in here".

31. **Multi-user mode (opt-in).** Namespace memories per user; basic email+password or token auth; per-user path guards. Not a SaaS — a self-hosted "family installation".
32. **Pluggable MCP transports.** Support HTTP+SSE in addition to stdio so remote agents can talk to a single Aperio instance.
33. **Memory provenance.** Every memory tracks where it came from (manual, scan, summary, import) — and you can filter / explain why something was recalled.
34. **Encrypted-at-rest option.** SQLCipher-style for LanceDB or pgcrypto column-level for Postgres, behind a passphrase you set on first run.
35. **Telemetry that respects privacy.** Local-only metrics (recall rate, embedding latency, token spend) surfaced in the UI. Nothing leaves the machine.
36. **Public threat model document.** What does Aperio defend against? What does it explicitly *not*? Honesty here is a competitive advantage in the local-AI space.

---

## Part 3 — Feature Suggestions

Some are obvious extensions of the existing surface; some are bets. Loosely ordered by effort-to-value ratio.

### Low-effort, high-impact

- **Memory pinning + collections.** Let users group related memories ("work", "kids", "side-project-x") and pin a collection as always-in-context.
- **Quick-capture command bar.** `Cmd+Shift+M` from anywhere on the page → a one-line modal that creates a memory without leaving what you were doing.
- **Smart import from common sources.** Drop a folder of Markdown notes / Obsidian vault / Notion export → each note becomes a memory with title, tags from frontmatter, content as body.
- **"Why was this recalled?" tooltip.** When the agent uses a memory, show similarity score and which query triggered it. Builds trust.
- **Memory similarity heatmap.** A small visualisation in the sidebar that shows which memories cluster — surfaces accidental duplicates and gaps.
- **Per-memory expiry suggestions.** Use the agent itself: "this looks like a temporary fact, expire in 30 days?" with one-click confirm.

### Medium-effort, high-impact

- **Hybrid search UI.** Toggle between "exact", "semantic", "hybrid" with sliders for type/tag/importance filters.
- **Conversation forking.** Right-click a message → "Branch from here" creates a new session sharing the prefix. Great for exploring alternatives without losing the original thread.
- **Voice input + dictation.** Web Speech API → input bar. Cheap to add, hugely accessible.
- **PWA + mobile shell.** Service worker for offline reads, manifest for install. The chat UI already responsive-ish — finish it.
- **Live folder watch.** Point Aperio at `~/Documents/notes` → it watches for changes and offers to ingest new files. Memory layer that *grows itself*.
- **Periodic self-summarisation.** Once a week, the agent re-reads stale memories, proposes consolidations, lets the user approve.
- **Browser extension companion.** Highlight text on any page → "Save to Aperio" with auto-tagged source URL. The most-used personal-memory feature in every competitor.
- **Slack / Discord / Telegram bridge.** A bot that exposes `/remember` and `/recall` slash commands inside a personal channel. Memory lives in Aperio; the bot is just a thin client.
- **Rich terminal client.** `lib/terminal.js` is already 600 lines — push it further into a TUI with split-pane history, search, attachments-as-glyphs. Make it the *first-class* interface for power users.

### Larger bets

- **Semantic graph view.** Memories as nodes, similarity as edges, force-directed layout. Click a node → recall surfaces. Visual recall is *very* powerful for personal data.
- **"My agent" prompt sandbox.** A live editor for `prompts/whoami.md` with side-by-side preview of how the agent responds before/after. The single most impactful file for personalisation; treat it like one.
- **Outbound integrations as MCP tools.** Calendar (read), email (read recent threads), file system watcher, code-aware search of personal repos. Each is an opt-in toggle and a tool registration; the rest already works.
- **Proactive assistant mode.** Aperio occasionally pings the user: "It's been a week since you mentioned the Ledger project — want to log progress?" Driven by importance + age + tags.
- **Cross-device sync (without a cloud).** Two Aperio instances that paired sync over Tailscale / local mDNS. Personal memory should not require trusting a third-party server, but it *should* work on every device.
- **Plugin / skill marketplace.** Today's `skills/` is a folder of markdown. Same shape, but with semver, install via `aperio skill install <name>`, and signed manifests.
- **Agent-driven memory curation.** Run a nightly batch: detect contradictions, propose merges, suggest tags. Write the recommendations to a `pending_curations` table; let the user approve in bulk.
- **"Aperio Lite" desktop app.** Wrap the existing server in Tauri or Electron. The same UI you have today, but as a real macOS / Windows / Linux app icon. Removes the entire "first you install Node…" friction.
- **Speech-to-memory.** Hold a key, dictate, release → transcribed and saved as a memory with timestamp and `voice` tag. Combine with proactive mode for "morning brain dump" rituals.

---

## Suggested first sprint (concrete)

If you wanted a 5-day sprint to feel a real difference, I'd do exactly this:

| Day | Items |
|-----|-------|
| **1** | Phase 1 #1 (`/api/memories` Postgres bug), #2 (`streamUsage`), #7 (`db/index.js` cleanup), #8 (body size limits) |
| **2** | Phase 1 #3 (per-connection paths), #4 (`fs.realpath`) — these go together |
| **3** | Phase 1 #5 (bind localhost), #6 (SECURITY.md), #9 (`~` handling), #10 (process error handlers) |
| **4** | Phase 2 #18 (one Playwright e2e test) — proves Phase 1 didn't regress anything user-visible |
| **5** | Phase 2 #11 (split `lib/agent.js`) — by now you'll have a feel for what's safe to move |

By the end of the week you'd have a server that's correct under concurrency, can't be tricked by symlinks, can't accidentally bind to the wrong interface, has a security policy that isn't a lie, and an automated check that the critical path still works. That's a real foundation.

Everything in Phases 2–4 then gets to be additive, and Part 3's feature ideas can be picked up by anyone (including you) without fear of stepping on someone else's in-flight refactor.

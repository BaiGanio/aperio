# Demo video — iteration brief

Instructions for the model doing the next iteration of the Aperio marketing video
(landing page + LinkedIn). Read this whole file before touching anything. v1 shipped
2026-07-03; we will iterate several times. Keep this file updated: log each iteration
at the bottom and fold any new hard-won lesson into the sections above it.

## What exists (v1)

All in `var/demo/` (gitignored):

- `aperio-demo.mp4` — 28.9 s, 1600×1000, 7.4 MB. Storyline: greeting → user asks
  "What do you remember about my mom's birthday? Any gift ideas?" → `recall` tool
  chips fire → answer streams with recalled facts → sidebar search "lisbon" →
  light/aurora theme flip.
- `aperio-demo.gif` (800 px) / `aperio-demo-small.gif` (640 px) — fallbacks.
- `record.js` — the Playwright driver. Prints `MARK <sec> <label>` lines used for
  cutting. Video time ≈ MARK time − ~4 s (browser launch offset).
- `README.md` — v1 recipe summary.

## Non-negotiables (every iteration)

1. **No real data.** Record against a throwaway SQLite DB seeded with fictional
   memories. Never point at the user's live DB — the video is public.
2. **Real recording.** Everything on screen actually happened. Time-compressing
   waits in post is fine; faking UI is not.
3. **~30 s target** (28–32 s). MP4 is the primary deliverable; GIFs are fallbacks.
4. Version outputs: `aperio-demo-v2.mp4`, `-v3`, … — never overwrite a shipped cut.
5. Verify before declaring done (checklist at the bottom).

## Harness mechanics — hard-won, don't rediscover

**v4 note (2026-08-21): Ollama is gone from this repo — use llama.cpp.** The
recipe below through v3 assumed Ollama (`AI_PROVIDER=ollama`, port 11434). The
project migrated to a vendored llama.cpp engine (epic #226) before v4; Ollama
support was removed (`lib/helpers/ollamaMigrationShim.js` refuses to boot on
an `AI_PROVIDER=ollama` .env). Use the harness below instead.

**Server** (run from repo root; pick a port that isn't 31337/1701):

```sh
AI_PROVIDER=llamacpp PORT=31338 \
DB_BACKEND=sqlite SQLITE_PATH=<scratchpad>/aperio-demo.db \
APERIO_DB_ENCRYPT=off EMBEDDING_PROVIDER=transformers \
APERIO_CODEGRAPH=off APERIO_DOCGRAPH=off IDLE_TIMEOUT_SECONDS=36000 \
APERIO_BENCHMARK_RUN=1 \
node server.js
```

- `.env` sets `IDLE_TIMEOUT_SECONDS=180` — without the override the server
  (and llama-server with it) self-terminates after 3 idle minutes, mid-session.
- `APERIO_BENCHMARK_RUN=1` is required — without it `server.js` auto-opens a
  real system browser tab at `/setup` or `/` (see `lib/server.js`'s
  `launchBrowser` calls). That tab is not part of the recording, races with
  whatever browser tool actually drives the recording, and — found live —
  can get stuck on the `/setup` wizard's completion screen with no way to
  reach the chat UI (a separate app bug: the wizard's 5/5-done screen has no
  continue button/auto-redirect). Setting this env var is the only way to
  suppress the auto-launch.
- Kill the demo server with **SIGKILL** (`kill -9 <pid>`, find via `lsof -ti :31338`).
  Graceful shutdown cascades into stopping llama-server too (`lib/helpers/shutdownGuard.js`
  routes SIGTERM through the full teardown); SIGKILL leaves it warm for the next take.
- Turn `APERIO_DOCGRAPH` / `APERIO_CODEGRAPH` **on** only if that iteration demos
  them (see storyboard), and point them at fictional content, never the real repo
  or the user's documents.
- `unsloth/gemma-4-E2B-it-qat-GGUF` (whatever quant is in the repo's `.env`
  `LLAMACPP_MODEL`) is the only model tested under llama.cpp so far (v4). It's
  noticeably smaller/weaker than v1–v3's Ollama `gemma4:e4b` — it needs the
  `needsRecallScaffold` safety net (see Seeding, below) and still won't
  reliably call `doc_search` on its own even when the tool is available (see
  Storytelling rule #5 update). Budget more re-rolls, or try a bigger
  `LLAMACPP_MODEL_TIER_*` if the recording machine can afford it.

Prewarm before recording — llama.cpp's OpenAI-compatible endpoint, model alias
is always `aperio-main` (`lib/helpers/llamacppAliases.js`), not the raw repo id:
`curl http://127.0.0.1:8080/v1/chat/completions -d '{"model":"aperio-main","messages":[{"role":"user","content":"hi"}],"max_tokens":2}'`

**Isolation (v3, CRITICAL; v4 adds a second landmine)**: run the server with
**cwd inside the scratchpad** (`cd <scratchpad>/approot && node <repo>/server.js`)
AND pass `APERIO_ALLOWED_PATHS_TO_READ`/`_TO_WRITE=<scratchpad>/approot`
explicitly. The repo `.env`'s real allowlist otherwise seeds the fresh demo
DB, and with `APERIO_DOCGRAPH=on` the watcher indexes the user's REAL
projects — v3 leaked a real repo into the index this way, and the
chunk-embedding backlog pegged the CPU and starved the event loop until every
HTTP request hung. The cwd trick also keeps `var/` runtime junk (sessions,
logs) out of the repo. server.js resolves .env/public/skills/id from its own
`__dirname`, so any cwd is safe for THOSE paths — but NOT for everything:

- `bootstrap.js` (the first-run installer, added after v3) checks
  `./node_modules` and does other checks **relative to `process.cwd()`**, not
  `__dirname`. A scratch cwd with no `node_modules` makes it think this is a
  fresh install and try `npm install` there, which fails (no `package.json`)
  and blocks boot entirely. Fix: before spawning, symlink
  `<scratchpad>/approot/node_modules` → `<repo>/node_modules`.
- **Never use `os.tmpdir()` for the scratchpad root on macOS.** It resolves
  under `/private/var/folders/…`, and `lib/docgraph/indexer.js`'s
  `SKIP_DIRS` (`.git`, `node_modules`, `trash`, `var`, `coverage`) is checked
  against *every segment of the full absolute path*, not just segments under
  the watched root (`lib/docgraph/watcher.js`'s `ignored`/`isIndexable`) — so
  a tmpdir-based scratch root gets silently skipped, 0 docs indexed forever,
  no error logged. Use `/tmp/<name>-<rand>` directly instead (logged as
  code depth: `id/reference/tech-debt.md`, "Docgraph watcher — SKIP_DIRS…").

**Seeding**: `POST /api/memories/import`, JSON `{"memories":[{type,title,content,tags,importance}]}`.
**Keep seeded memories SHORT (v2 user feedback)** — the model digests them into
its answer, so long memories produce long answers that eat the 30 s budget and
are too much to read on screen. One or two tight sentences per memory; aim for
answers of 2–4 short lines so more beats/features fit in the cut.
State-changing API calls need header `x-aperio-client: demo` (any value). Valid types:
fact, preference, project, decision, solution, source, person. Embeddings backfill in
the background — watch the server log for "backfill complete" before recording.
A fresh DB self-seeds ~12 starter memories about Aperio itself; they're safe and
make the sidebar look lived-in. Response shapes, verified live (guessing these
wrong just silently returns nothing, no error): `GET /api/memories` →
`{raw: [...]}` (not `memories`/`data`); `GET /api/docgraph/search` →
`{enabled, matches: [...], mode}` (not `results`/`data`).

**v4 addition — the recall safety net needs the model listed, exact string
match.** `lib/agent/preflight.js`'s `needsRecallScaffold` auto-fetches
memories server-side for a model that doesn't reliably call `recall` itself
(the whole point for a small local model), but only if the running model's
name is in `APERIO_RECALL_SCAFFOLD_MODELS` (falls back to
`APERIO_CAPABLE_MODELS`) — an **exact, case-insensitive string match**, no
fuzzy quant-suffix handling. Found live: the repo's `.env`
`APERIO_CAPABLE_MODELS` was missing the "UD-" prefix that `LLAMACPP_MODEL`
actually has, so the scaffold silently never fired and the payoff turn got no
memories at all. `record.js` now reads the real `LLAMACPP_MODEL` out of
`.env` and passes it back as `APERIO_RECALL_SCAFFOLD_MODELS` so the demo
isn't gated by that drift — but check this env var matches whenever the
demo model changes.

**Recording** (Playwright, installed in a disposable dir with `npm i playwright`):

- **Chromium-family only.** Firefox's video capture produces black-box glitch frames
  under generation load. **v4 (user feedback): record with a real browser, not the
  Playwright-bundled one** — `chromium.launch({ executablePath: BRAVE_PATH, ... })`
  pointed at `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`. Brave is
  Chromium underneath, so this doesn't reopen the Firefox glitch risk; Playwright still
  manages an isolated temp profile even with a custom `executablePath` (doesn't touch
  the user's real Brave profile/extensions/history). Falls back to bundled Chromium
  with a console note if Brave isn't found at that path.
- Busy/idle detection: generation is in flight while `#thinking` exists **or**
  `#stopBtn` has `display:flex`. `record.js` has `waitGenStart`/`waitGenEnd` — reuse them.
- Theme preset: `localStorage.setItem("aperio-theme", "aurora")` in an init script.
  Reasoning: `localStorage.setItem("aperio-reasoning", ...)` (boot-sync can
  re-override from DB; re-check after load and click `#reasoningToggle` if needed).
  **v3+: reasoning ON is a featured beat (user feedback D)** — turn it off only in
  segments where speed matters more than showing the feature.
- **Voice responses OFF (v2 user feedback A)**: `localStorage.setItem("aperio-tts",
  "false")` in the init script — otherwise speechSynthesis reads every answer
  aloud on the recording machine. Same boot-sync trap as reasoning: re-check the
  key after load (settings.js syncs `aperio-tts` from the DB) and toggle it off
  via the settings panel if it came back on.
- **Ambient background OFF (v4 user feedback)**: `localStorage.setItem(
  "aperio-ambient", "off")` in the init script (see `public/scripts/ambient.js`
  — also has `"auto"`/`"on"`). The floating bokeh/aurora particle animation
  behind the chat looks smooth at real speed but turns into a jerky strobe once
  a "thinking" span gets fast-forwarded 25× in the cut. Fix it at record time,
  not in post. Bonus found by accident: turning it off also shrank every
  output file hard (v4's MP4 went 8.0 MB → 2.4 MB, GIFs stopped needing
  fps/color cuts to hit the size budget) since there's far less per-frame
  motion for any encoder to chew on — worth doing even before the strobing is
  a concern.
- **UI at ~125% (v2 user feedback B)**: v2's element/font size read too small.
  Preferred: set the product's own font scale, `localStorage.setItem(
  "aperio-font-scale", "1.25")` (role-based type scale, see
  `public/styles/TYPOGRAPHY.md`) — product-native, no layout risk. Alternative:
  shrink the viewport to 1280×800 (recorded at 2× = 2560×1600) so everything is
  25% larger relative to frame. Either way, screenshot a dry run and eyeball
  legibility before recording; don't use browser/CSS page zoom (breaks 100vh).
- The startup greeting is a full model turn — wait it out with `waitGenEnd` before
  interacting, and dismiss the "~N tokens at startup" banner (button text "Dismiss").
- Sidebar memory search (`#searchInput`) is a **substring** filter over
  title/content/tags — one word ("lisbon"), never a phrase ("lisbon trip" = 0 rows).
- Recordings don't capture the OS cursor — `record.js` injects a fake one; keep it.
- Useful selectors: `#chatInput`, `#sendBtn` (disabled until text; hidden while busy),
  `#memoriesBtn`, `#memory-search`, `.theme-btn[data-theme=…]`, `#attachBtn`, `#discussBtn`.

**Cutting**: ffmpeg trim/setpts/concat keyed off the MARK lines. v1 recipe: keep
typing/answer/search/flip at 1×, compress the recall phase ~28×, stream-in at 2.5×.
Extract frames (`-vf fps=1`) and *look at them* at every cut point before encoding GIFs.

## Zoom / component callouts (new for v2)

Goal: when we click something (reasoning toggle, recall chip, a saved memory, the
context meter), zoom in so the viewer can't miss it.

Preferred approach — **post-production zoom on the headless recording**:

1. Record at 2× — but **`deviceScaleFactor` alone does NOT work**: Playwright's
   recordVideo never upscales, so a 3200×2000 `recordVideo.size` just pads the
   1600×1000 page with black. Launch Chromium with
   `--force-device-scale-factor=2` (plus `deviceScaleFactor: 2` in the context);
   verified in v2 to produce true 3200×2000 frames. CSS `zoom: 2` on the root is
   NOT a substitute — `100vh`-based layout breaks (input bar lands off-frame).
2. In `record.js`, log the bounding box of every element you interact with:
   `MARKBOX <sec> <label> x,y,w,h` right before the click. That gives exact
   zoom targets and timestamps.
3. In ffmpeg, animate crop/scale toward the logged box (zoompan, or an
   `scale`+`crop` with animated expressions), hold ~1.5 s, zoom back out.
   Ease in/out — snap zooms look broken.

Alternative the user mentioned — **macOS Accessibility Zoom** (System Settings →
Accessibility → Zoom, ⌃+scroll to zoom at the pointer): only applies if an iteration
is recorded as a *real screen capture* of a headed browser (QuickTime/`screencapture -v`
+ human or script driving). It's less reproducible; use it only if the user asks for a
hand-recorded take. In-page CSS `transform: scale()` on the app root is a third option
but risks layout/scroll artifacts — prototype before committing.

Rules for zooms: max 3 per 30 s video, one subject each, ≥1.2 s hold, always return
to full frame before the next beat.

**v4 (2026-08-22, user feedback: "use zoom when clicking the buttons") — implemented,
not yet verified on real footage.** `var/demo/v4/cut.js` (a Node generator, not the
older hand-typed `cut.sh` — reads `marks.txt`/`MARKBOX` and looks up beat boundaries
by label, so a re-record doesn't need the arithmetic redone by hand):

- **ffmpeg's `crop` filter does NOT animate `w`/`h` with `t`** — only `x`/`y` are
  re-evaluated per frame; a `t`-varying height expression errors out at filter init
  (`Error when evaluating the expression`, confirmed live with a synthetic
  `testsrc` probe before touching real footage). So a single continuous
  "zoom expression" crop is not available.
- Worked around with **discrete per-frame crop steps**: ease-in/out (0.35 s each,
  ~8-9 raw frames at 25fps) is built as a sequence of tiny (~0.04 s) segments, each
  with its own constant, JS-computed (not ffmpeg-expression) crop size — one
  distinct crop per frame reads as a smooth zoom, not a slideshow, without needing
  ffmpeg to animate anything itself. Hold is one longer segment at the fixed target
  zoom (2.0×). Validated the concat-of-many-tiny-crops mechanic on synthetic
  footage (works, correct duration) before generating the real filter graph.
- Scoped to actual button clicks per the feedback, not every MARKBOX: sidebar
  toggle, memory-card reveal, dark-theme switch, reasoning toggle. Deliberately
  skipped: the aurora theme switch (v3's own rule — a theme flip is "inherently
  visible," full-frame is fine) and the docgraph citation chip (its MARKBOX is
  ~1100px wide — already near full-frame, so a contain-the-whole-box zoom crop
  works out to ~1.0× anyway, not worth the complexity for no visible effect).
- **Not yet run against a real take** — every recording attempt after this was
  written hit a model problem (see the iteration log) before reaching the cut
  step. First real render of `cut.js` should extract frames at each zoom's
  start/hold/end and eyeball them (same discipline as the plain-cut verification
  above) before trusting it.

## Storytelling rules — v2 user feedback, binding for v3+

v2 verdict: vibe and zooms landed; structure didn't. Apply these to every
future storyboard:

1. **One story, not scattered pieces (feedback E).** v2's three examples (Atlas
   teach / mom's birthday / Postgres decision) were mutually irrelevant — the
   Atlas thread ended too quickly and the unrelated follow-ups killed the
   interest it had built, hooking neither non-coders nor developers. Every beat
   must continue the previous one: teach a fact early, then *use that same fact*
   (alone or combined with seeded context) in the payoff. Storyboard C ("Watch
   it learn") already has this shape; A/B need rewriting around a single thread
   before reuse.
2. **The theme vibe carries the video (feedback C).** Don't park the theme flip
   at the end as a flourish — let the aurora/theme personality persist
   throughout, and when switching colors, zoom in on the switcher so the viewer
   feels the vibe. The goal: they like the project before they've touched it.
3. **Show reasoning (feedback D).** The reasoning toggle/bubbles are a cool,
   differentiating feature and v2 hid it (we recorded with reasoning off for
   speed). Make viewers curious about what it is: a zoomed moment on the toggle
   or a visible thinking/reasoning bubble. Budget the extra per-turn time it
   costs.
4. **Short answers on screen.** Users will try to read whatever streams in —
   keep it readable in the beat's time slot (see the short-memories rule in
   Seeding above). v3 additions: put "Briefly." / "Keep it short." IN the
   prompt (gemma ships essays otherwise), and gate takes on the full answer
   text with length caps (v3 used 900/1200 chars) so a bad take re-rolls
   automatically.

5. **Prompt phrasing is tool routing (v3).** The demo prompts must hit the
   product's activation regexes or the feature being demoed silently doesn't
   fire: docgraph needs "my notes" as adjacent words ("my research notes"
   does NOT activate `doc_search` — see the profile regex in
   `lib/agent/tool-profiles.js`); the deterministic auto-recall needs
   RETRIEVAL_RE phrasing like "what do you remember" (same file), otherwise
   gemma answers from conversation context and ignores seeded memories. And
   gemma won't restate a fact taught earlier in the session unless directly
   asked ("When exactly do I start…") — the payoff prompt must interrogate
   the taught fact, not just invite a summary.

   **v4 confirms this the hard way**: `"What did my research notes say about
   Northwind Labs?"` (broke the adjacency rule above) never attached the
   `docgraph` tool profile at all — fixed by rewording to `"What do my notes
   say about Northwind Labs?"`. Even after that fix, with `gemma-4-E2B` under
   llama.cpp (v1–v3's Ollama `gemma4:e4b` was noticeably more capable), the
   tool profile attached correctly but the model still narrated *pretending*
   to search ("I will recall what your notes say... (Searching memory store
   for...)") instead of actually calling `doc_search`, then claimed no notes
   existed. There is no `needsRecallScaffold`-equivalent auto-injection for
   `doc_search` (that safety net only covers the `recall` tool) — so on a
   weak model, the docgraph beat may need several re-rolls, or a more
   directive prompt ("Use doc_search to check my notes about Northwind
   Labs."), or dropping to a bigger model for this beat specifically.

## Beat library

Reusable building blocks — every concept below is assembled from these. Budget is
brutal: 3–4 beats fit in 30 s.

1. **Teach it** *(shows memory write, the core loop)*: type "Remember that the
   Atlas launch moved to September 14" → memory auto-saved → zoom on the sidebar
   count/new memory card as it appears.
2. **Personal recall** *(the v1 emotional hook)*: mom's birthday + gift → answer
   with recalled date and the vase.
3. **Work recall**: "What did we decide about the analytics database?" → recalls
   the seeded Postgres-over-MySQL decision with the reasoning.
4. **docgraph**: seed a fictional contract/spec PDF into a watched folder
   (`APERIO_DOCGRAPH=on`), ask "what's the termination notice period in the
   Northwind contract?" → cited answer. Needs indexing lead time — verify with a
   test query before recording.
5. **codegraph**: point at a small fictional/OSS repo, ask "where is X defined and
   who calls it?" (`APERIO_CODEGRAPH=on`, index first).
6. **Discuss / roundtable** (`#discussBtn`): two local models debating — visually
   distinctive, but slow; only with aggressive time-compression.
7. **Chrome flourishes** (cheap, zoom-friendly): recall tool chips, context-window
   meter filling, reasoning toggle, sidebar search, theme flip ending.
8. **Terminal surface**: `npm run chat` in a real terminal answering from the same
   memories — proves it's one brain, two surfaces. Needs a second recording source
   (terminal capture) composited side-by-side or cut-to.

## Concept storyboards — pick one per iteration

Five directions to iterate on. Each fits ~30 s. Effort = setup work beyond the v1
harness. Whichever wins, log the choice and the result in the iteration log.

### A. "Work and life" (v1 evolved) — effort: low
The pairing is the message: one brain for both halves of your day.
- 0–6 s   Teach it a work fact → zoom on the memory card appearing in the sidebar
- 6–16 s  Personal recall (mom's birthday, kept from v1) → zoom on recall chip firing
- 16–26 s Work recall (Postgres decision) → answer streams (compressed)
- 26–30 s Aurora flourish close on the full UI
- Risk: two full model turns to compress; recording will run ~4 min raw.

### B. "The second brain at work" — effort: medium
All business: for the LinkedIn audience specifically. No personal beats.
- 0–6 s   Teach it: "Remember: staging deploys are frozen until the audit ends"
- 6–15 s  Work recall with the decision + reasoning → zoom on the recalled facts in the answer
- 15–26 s docgraph: contract question → zoom on the citation/source reference
- 26–30 s Context meter + theme close
- Risk: docgraph seeding + indexing is new harness surface; dry-run the query first.

### C. "Watch it learn" — effort: low
One idea, drilled: memory is a loop, not a database you fill in by hand.
- 0–8 s   Teach it two quick facts back-to-back → zoom on sidebar count ticking up
- 8–12 s  Sidebar search finds them instantly (substring, so single words)
- 12–26 s Ask one question that needs BOTH facts combined → answer weaves them together
- 26–30 s Slow zoom-out to full aurora UI
- Strongest single-message video; weakest feature breadth. Verify the model actually
  saves memories from natural phrasing before promising this cut (dry-run step 4).

### D. "Your documents, answered" — effort: high
docgraph-led; positions Aperio against "chat with your PDF" tools but local-first.
- 0–6 s   Finder/terminal shot: drop `northwind-contract.pdf` into the watched folder
- 6–12 s  Server log or UI showing the doc indexed (timelapse)
- 12–26 s Ask the termination-notice question → cited answer → zoom on the citation
- 26–30 s Second quick question or flourish close
- Risk: highest new-surface count (file-drop shot, watcher timing, citation UI);
  prototype each piece before committing to the storyboard.

### E. "Feature tour" — effort: medium-high
Rapid-fire montage, 4–6 s per feature, hard cuts, for people who skim.
- 0–6 s   Recall answer (pre-warmed, join mid-stream so it's instantly moving)
- 6–11 s  Memory browser / sidebar search
- 11–17 s docgraph or codegraph answer
- 17–23 s Roundtable discussion (heavily compressed)
- 23–30 s Theme flip → logo/tagline end card
- Breadth over depth; every segment must be pre-verified working since there are
  five chances for something to look broken. Consider building it from *separately
  recorded* takes per feature rather than one continuous session — cuts hide seams.

**Recommendation**: ~~iterate A → B~~ *(v2 shipped A; superseded by the
Storytelling rules above)*. **v3 is decided — "Day one", concept E's feature
breadth told as one story; full beat list in the iteration log below.** For
later iterations, A/B/C/D/E remain raw material but their beat lists must be
rewritten to a one-story arc with a wide-audience protagonist first.

## Per-iteration workflow

1. Read this file + `var/demo/record.js`. Check which models exist: `curl -s localhost:11434/api/tags`.
2. Agree the beat list with the user (or take it from their message).
3. Fresh scratchpad DB, seed, verify embeddings backfilled, prewarm model.
4. Dry-run the driver script; dump the final answer text (`record.js` does this) and
   **read it** — models flub recall wording; re-roll or rephrase until the answer is
   demo-worthy. Answer quality gates everything else.
5. Record, extract frames at 1 fps, eyeball every beat and cut point.
6. Cut, encode MP4 (libx264, crf 20, yuv420p, +faststart) and GIFs, copy to
   `var/demo/` with a new version suffix, update `var/demo/README.md`.
7. SIGKILL the demo server; confirm Ollama still answers `/api/tags`.

## Done checklist

- [ ] Answer text on screen is correct and flattering (no refusals, no hallucinated facts)
- [ ] No glitch/black frames at 1 fps sampling
- [ ] No real personal data anywhere in frame (memories, paths, file names, model of the user's life)
- [ ] 28–32 s; MP4 < 10 MB; GIF < 15 MB
- [ ] Zooms: ≤3, eased, legible target, returns to full frame
- [ ] Old versions kept; README + iteration log below updated

## Iteration log

- **v1 (2026-07-03)**: mom's-birthday recall + sidebar search + theme flip.
  gemma4:e4b, Chromium, aurora theme. Lessons folded in above (idle timeout,
  Firefox glitches, phi4 refusal, substring search).
- **v2 (2026-07-03)**: concept A "Work and life" — teach Atlas date (zoom on the
  new sidebar memory card via search filter), mom's-birthday recall (zoom on the
  recall tool card), Postgres work recall, light→aurora close. 31.6 s / 8.5 MB
  MP4 + 720/640 px GIFs in `var/demo/v2/` with the driver, take-loop and cut
  scripts. New hard-won lessons folded in above and worth re-reading before v3:
  - `--force-device-scale-factor=2` is required for a real 2× recording (see
    zoom section); MARKBOX boxes are CSS px, ×2 for video px; video ≈ MARK − 1.2 s.
  - **Never delete memories in the demo DB.** `forget` leaves an orphaned
    `vec_memories` row, after which every `remember` dies with a UNIQUE
    constraint error while the model *claims it saved* (bug in `db/sqlite.js`
    `delete()` — memories row deleted, vec row not). Two takes lost to this.
    Reset the whole DB per attempt instead (`var/demo/v2/take-loop.sh`).
  - Verify the teach beat persisted (fetch `/api/memories` in-driver) and abort
    early on failure; remember-tool args are nondeterministic across takes.
  - Sidebar type-groups preview only 3 cards; use the search filter to surface
    a fresh memory on camera.

  **User verdict on v2**: liked it overall — vibe touched, zooming handled
  perfectly. Five fixes requested, folded into the sections above: (A) voice/TTS
  was audible during recording → force `aperio-tts` off (Harness mechanics);
  (B) fonts/elements too small → ~125% UI scale (Harness mechanics); (C) theme
  vibe should persist throughout + zoom on the color switch (Storytelling
  rules); (D) reasoning feature missing, should spark curiosity (Storytelling
  rules); (E) three disconnected examples killed the hook — tell ONE story
  (Storytelling rules); plus: seed short memories so answers stay short and
  readable, freeing time for more features (Seeding).

- **v3 (chosen 2026-07-03): "Day one" — a feature tour told as one story.**
  Concept E's breadth, narrated as a single arc everyone recognizes: starting a
  new job. Candidate stories from the user's real memory export (var/demo/
  aperio-export-2026-06-26.json — REAL data, inspiration only, never on screen)
  were judged too narrow (a trade-finance deal brief "narrows the circle of
  people who might recognize themselves"); this one keeps the same feature arc
  with a universal protagonist. All names/documents fictional.

  **Themes are the choreography, not a beat.** Themes are the soul of Aperio:
  every prompt gets its own mood — the theme switches *with* the story so the
  viewer feels how it affects mood and energy. Three moods for three beats
  (exact presets picked at recording from the available `.theme-btn` set), the
  first switch zoomed on the switcher, later ones full-frame (a theme flip is
  inherently visible), settling on aurora for the payoff.

  Beat list (~30 s, obeys every Storytelling rule above):
  - 0–5 s   *Mood 1 (calm)* — **Teach**: "Remember: my start date moved to
            Monday the 14th." → memory card appears in the sidebar
  - 5–7 s   **Theme switch, zoomed on the switcher** — energy rises with the
            next question
  - 7–15 s  *Mood 2* — **Ask your own notes** (docgraph, fictional research
            notes on "Northwind Labs" in the watched folder): "What did my
            research notes say about Northwind Labs?" → cited answer → zoom
            on the citation
  - 15–17 s **Theme switch to aurora** (full-frame) — the payoff mood
  - 17–28 s *Aurora* — **Payoff with reasoning ON**: "Brief me for day one."
            → reasoning bubble visible (zoom) → short answer weaving the
            taught start date + the notes finding + seeded facts (manager's
            name, 9:30 standup, laptop pickup at reception)
  - 28–30 s Settle on the full aurora UI
  - Story in one line: *it remembered the change, it read my research, it
    briefed my first day — and the mood moved with me.*
  - Zoom budget (≤3): theme switcher, citation, reasoning bubble. The memory
    card in beat 1 must be legible without zoom (short title, 125% scale).

  Harness requirements: TTS off, reasoning ON for the payoff turn, ~125% UI
  scale, seeds of 1–2 sentences each, docgraph enabled pointing ONLY at the
  fictional research-notes document — dry-run the docgraph query and read the
  citation before recording (new surface; storyboard D's warnings apply).
  Check which theme presets exist before scripting the mood sequence.

  **v3 SHIPPED (2026-07-03)**: 31.9 s / 6.7 MB MP4 + 720/640 GIFs in
  `var/demo/v3/` with driver, take-loop, cut script and README. Story as
  planned: light/teach → zoomed switcher → dark/docgraph culture question
  (cited `notes/northwind-labs-notes.md` answer) → aurora → reasoning-ON
  payoff ("When exactly do I start, and what do you remember about my first
  day? Keep it short.") weaving Monday-the-14th + laptop/badge at reception +
  Priya Sharma coffee + Platform team + 9:30 standup. Zooms: switcher,
  citation bubble, reasoning bubble. Theme presets used: light → dark →
  aurora. Took 3 gated takes (2 payoff-prompt iterations); prompts above are
  the ones that work — don't regress them. New hard-won lessons folded into
  Harness mechanics (Isolation) and Storytelling rules (#4 length gates, #5
  prompt-phrasing-is-tool-routing). Deliberate imperfection kept: take 3's
  teach answer asks "if the date is in a specific month or year, please
  provide it" — honest model behavior, judged acceptable vs the cost of
  another take; re-roll if the user disagrees. gemma+reasoning empty-completion
  (the "(The model finished thinking but produced no response.)" placeholder)
  appeared in 1 of 3 dry/real payoff turns — the take gates catch it; budget
  re-rolls when reasoning is ON.

- **v4 (2026-08-21): "Day one" ported to llama.cpp + the mascot
  open.** Ollama is gone from the repo (llamacpp epic #226) since v3 shipped,
  so this iteration is mostly a harness port, not a new story — same beats as
  v3, plus the mascot-open idea below (1 s aurora-robot card at 0:00, outro
  hold trimmed to keep ~30 s). Driver: `var/demo/record.js`. Model:
  `unsloth/gemma-4-E2B-it-qat-GGUF` (whatever quant `LLAMACPP_MODEL` names) —
  the only one tried so far under llama.cpp, and weaker than v1–v3's Ollama
  `gemma4:e4b` (see Harness mechanics and Storytelling rule #5 above for what
  that cost). Six infra bugs found and fixed getting the harness to boot at
  all (all folded into Harness mechanics above): the app's own
  `APERIO_BENCHMARK_RUN` auto-browser-launch colliding with the recording;
  `bootstrap.js`'s cwd-relative `node_modules` check; `os.tmpdir()` colliding
  with docgraph's `SKIP_DIRS`; wrong response field names for
  `/api/memories` and `/api/docgraph/search` (`raw` and `matches`, guessed
  wrong twice); the `APERIO_CAPABLE_MODELS`/`LLAMACPP_MODEL` quant-suffix
  drift silencing the recall safety net (also fixed in the real `.env`, not
  just the demo harness); and the docgraph prompt's "my research notes" vs
  "my notes" adjacency miss.

  Getting a demo-worthy docgraph beat took 5 more re-rolls even after the
  wording fix — `gemma-4-E2B` under llama.cpp is inconsistent turn to turn on
  this beat specifically: narrated a fake search without calling `doc_search`
  (take 8); answered correctly but far too long, 760 chars (take 9, fixed by
  adding "Keep it to one short sentence." to the prompt); a bare refusal in
  two different phrasings the gate didn't originally catch, "I did not find
  any…" and "I could not find any…" (takes 10, 12 — `record.js`'s
  `REFUSAL_RE` now covers the whole did/could(n't) find any/it/that/anything
  family); and once a *wrong-topic* answer — short, confident, no refusal
  wording, but it answered from the seeded onboarding memories instead of the
  actual note content (take 11, passed every length/refusal gate anyway).
  That last one is why `gateAnswer()` grew a `mustMention` check: a short,
  polite, on-schema answer can still be about the wrong thing, and
  length/refusal regexes alone can't catch that — only checking for the
  expected content can. Take 13 passed clean on all three beats, docgraph
  correctly citing "flat structure, async-first… onboarding buddies," payoff
  weaving three seeded facts together (laptop/badge, Platform team, manager
  Priya Sharma). Kept as the shipped take.

  Raw take in `var/demo/v4/` (`aperio-demo-v4-raw.webm`, `marks.txt`,
  `take-report.json`, `server.log`). Raw runtime is ~245 s, not ~30 s — real
  model latency per turn (teach ~72 s, docgraph ~71 s, payoff ~84 s) on this
  model/hardware; expected, per Cutting above the MARK lines are exactly what
  time-compression in post needs.

  **Cut and shipped same day.** `var/demo/v4/cut.sh` — one `ffmpeg
  filter_complex` (trim+setpts per segment, concat, no re-encode of
  intermediates) built straight off `marks.txt`: real time for
  typing/answers/theme-flips, 25× fast-forward through each `genStart`→`genEnd`
  span, holding the last ~2s of each generation at 1× so the answer is
  readable before the cut. Extracted frames at every segment boundary and read
  them (image tool, not just fps=1-and-guess) before calling it done, per the
  Cutting rule below — caught one real defect this way: the very first ~0.15 s
  was a blank white flash (the new Chromium page's default about:blank before
  the mascot `file://` page paints), invisible in MARK timestamps since
  `mascot_open:show` logs right after `page.goto()` resolves, not after first
  paint. Fixed by starting the cut at 0.15s instead of 0.00s. Every other
  boundary was clean — no black/glitch frames, and the app's own
  greeting-bubble mascot avatar happens to visually continue the mascot-open
  card, unplanned but a nice touch.

  First cut (take 13, 31.3 s, crf 23): **8.0 MB MP4** (crf 20 hit 11.9 MB, over
  the 10 MB target). GIF export needed real tuning to hit the <15 MB budget —
  the animated bokeh/aurora background is a lot of per-frame color change for
  GIF to compress. `fps=12` + full palette blew past 15 MB by 2× (34 MB at
  800px). `fps=8, max_colors=128` got the 640px fallback under budget
  (13.1 MB) but not 800px (19.5 MB); `fps=6, max_colors=96, bayer_scale=4` got
  800px to 12.0 MB. Text stayed sharp at every step — the color/motion budget
  goes into the background bloom, not the text bubbles.

  **User feedback on take 13: the fast-forwarded background looked jerky.**
  25×-speeding a `genStart`→`genEnd` span turns the ambient bokeh/aurora
  particle drift into a strobe. Fix folded into Harness mechanics above
  (`aperio-ambient=off`) — re-recorded rather than trying to smooth it in
  post, since it's baked into the raw pixels. The retake (superseding take 13,
  same story/prompts, `aperio-ambient=off`) passed every gate on the first
  try and, as a bonus, needed none of the GIF tuning above: with a calm
  background there's far less per-frame motion to encode, so plain
  `fps=12`/full-palette GIFs came in under budget on the first attempt.

  **Deferred, not forgotten**: no zoom/crop effects this round (the
  `MARKBOX` data is in `marks.txt` for a future pass — see
  `var/demo/v4/README.md`). **Shipped**: `aperio-demo-v4.mp4` (30.9 s,
  2.4 MB), `aperio-demo-v4.gif` (800px, 4.8 MB), `aperio-demo-v4-small.gif`
  (640px, 3.2 MB) — all in `var/demo/v4/`, gitignored; not yet placed
  anywhere outside that folder.

- **v4 continued (2026-08-22) — IN PROGRESS, not shipped.** The files currently
  sitting in `var/demo/v4/` (`aperio-demo-v4.mp4`/`.gif`/`-small.gif`) are the
  ambient-off take from the entry above — **stale**, recorded before every
  change in this entry. Don't treat them as current. No take exists yet with
  all of the below together.

  **Three pieces of user feedback drove this round:**
  1. *"the theme were switched too early and the sidebar wasn't shrinked or
     expanded... this could be expanded after the remember"* — `record.js`
     now starts with `localStorage.setItem("aperio-sidebar", "closed")` and
     clicks `#sidebarToggle` (`public/index.js`) as its own beat right after
     the teach turn's answer, holds ~1.2s on the revealed memory card, then a
     0.5s breathing gap before the theme switch (previously instant
     back-to-back). Verified working in two recordings' `marks.txt` — the gap
     between `teach:card_check_done` and `theme_switch_dark:click` went from
     effectively 0 to ~1.7-2s.
  2. *"open this in brave or firefox, safari ain't best choice"* → clarified
     to mean **record with Brave**, not just preview in it. Implemented (see
     Harness mechanics above) — confirmed working live, no Firefox-style
     glitching (Brave is Chromium underneath).
  3. *"use zoom when clicking the buttons"* → `var/demo/v4/cut.js` written
     (see Zoom section above) — **implemented but never run against real
     footage**, because every recording after it was written hit a model
     problem before reaching the cut step (below). Test this first before
     trusting it.

  **Model exploration — the actual blocker.** User asked to try
  `gemma4-e4b` for richer answers (E2B's were correct but terse), then
  Ornith-1.0 as a fallback:
  - `gemma-4-E4B` (`unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL`): teach/payoff
    answers were the best of the whole project — payoff wove 3 seeded facts
    together unprompted. But **reproducibly (2/2) leaks a malformed
    `doc_search` call** on the docgraph beat's quoted-string query — a new,
    unfixed variant of the Ornith angle-bracket leak bug. Full details:
    `id/reference/tech-debt.md` → "gemma-4-E4B tool-call leakage." Do not
    retry this model on this beat until that's fixed upstream, or rephrase
    the docgraph prompt to avoid a quoted argument (untried — might dodge it
    without a code fix).
  - `Ornith-1.0` (`protoLabsAI/Ornith-1.0-9B-MTP-GGUF:Q4_K_M`): ~2x slower per
    turn (103s vs ~55s for the teach beat alone) and its one attempt hit
    "No bounding box for docgraph:send — element not visible" — `#sendBtn`
    wasn't there when the script went to click it, right after a very long
    teach turn. Only one data point; could be a real Ornith UI-timing quirk
    or just this script assuming turns stay under some implicit ceiling.
    Not investigated further.
  - **`gemma-4-E2B` (current `DEMO_MODEL` in `record.js`) stays the safe
    default** — plainer/shorter answers, but the only model that's produced
    a fully clean, all-three-beats-correct take this whole project. Also
    hit two unexplained "Target page, context or browser has been closed"
    crashes earlier in the session (both during the teach beat's long
    `waitGenEnd` wait) — never reproduced a third time, cause unknown,
    didn't correlate with the model or browser switch (happened both before
    and after switching to Brave). Worth watching for if it recurs.

  **Suggested next steps for whoever picks this up:**
  1. Record one clean take with `gemma-4-E2B` (already proven reliable) with
     today's sidebar/theme-timing/Brave changes — this alone closes out the
     original three pieces of feedback.
  2. Run `node var/demo/v4/cut.js` on that take, extract frames at each
     zoom's start/hold/end, and actually look at them before trusting the
     zoom effect.
  3. Only after that's confirmed working: decide whether richer E4B answers
     are worth chasing the tool-call-leak fix (a real, scoped bug in
     `lib/tools/executor.js` — see tech-debt.md), or stay on E2B.

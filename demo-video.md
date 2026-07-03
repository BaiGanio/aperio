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

**Server** (run from repo root; pick a port that isn't 31337/1701):

```sh
AI_PROVIDER=ollama OLLAMA_MODEL=gemma4:e4b PORT=31338 \
DB_BACKEND=sqlite SQLITE_PATH=<scratchpad>/aperio-demo.db \
APERIO_DB_ENCRYPT=off EMBEDDING_PROVIDER=transformers \
APERIO_CODEGRAPH=off APERIO_DOCGRAPH=off IDLE_TIMEOUT_SECONDS=36000 \
node server.js
```

- `.env` sets `IDLE_TIMEOUT_SECONDS=180` — without the override the server (and
  Ollama with it) self-terminates after 3 idle minutes, mid-session.
- Kill the demo server with **SIGKILL** (`kill -9 <pid>`, find via `lsof -ti :31338`).
  Graceful shutdown stops Ollama, which should stay up.
- Turn `APERIO_DOCGRAPH` / `APERIO_CODEGRAPH` **on** only if that iteration demos
  them (see storyboard), and point them at fictional content, never the real repo
  or the user's documents.

**Model choice** (tested 2026-07-03, all local via Ollama):

| Model | Verdict |
|---|---|
| gemma4:e4b | ✅ use this — recalls correctly, warm well-formatted answers; ~80 s/turn (compress in post) |
| phi4-mini:3.8b | ❌ fast but *refused* ("no access to personal information") instead of recalling |
| Qwen3.5:4b | ❌ thinking mode: >3 min per turn |

Prewarm before recording: `curl http://localhost:11434/api/generate -d '{"model":"gemma4:e4b","prompt":"hi","stream":false,"options":{"num_predict":2}}'`

**Isolation (v3, CRITICAL)**: run the server with **cwd inside the scratchpad**
(`cd <scratchpad>/approot && node <repo>/server.js`) AND pass
`APERIO_ALLOWED_PATHS_TO_READ`/`_TO_WRITE=<scratchpad>/approot` explicitly.
The repo `.env`'s real allowlist otherwise seeds the fresh demo DB, and with
`APERIO_DOCGRAPH=on` the watcher indexes the user's REAL projects — v3 leaked
a real repo into the index this way, and the chunk-embedding backlog pegged
the CPU and starved the event loop until every HTTP request hung. The cwd
trick also keeps `var/` runtime junk (sessions, logs) out of the repo.
server.js resolves .env/public/skills/id from its own `__dirname`, so any cwd
is safe.

**Seeding**: `POST /api/memories/import`, JSON `{"memories":[{type,title,content,tags,importance}]}`.
**Keep seeded memories SHORT (v2 user feedback)** — the model digests them into
its answer, so long memories produce long answers that eat the 30 s budget and
are too much to read on screen. One or two tight sentences per memory; aim for
answers of 2–4 short lines so more beats/features fit in the cut.
State-changing API calls need header `x-aperio-client: demo` (any value). Valid types:
fact, preference, project, decision, solution, source, person. Embeddings backfill in
the background — watch the server log for "backfill complete" before recording.
A fresh DB self-seeds ~12 starter memories about Aperio itself; they're safe and
make the sidebar look lived-in.

**Recording** (Playwright, installed in a disposable dir with `npm i playwright`):

- **Chromium only.** Firefox's video capture produces black-box glitch frames under
  generation load.
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

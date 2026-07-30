# Mascot Ecosystem Integration — Tests

Verification criteria for `mascot-ecosystem-integration.md`. Verify-first: confirm the
relevant criterion fails (red) before implementing each workstream.

## Coverage map

| Plan step | Test group | Coverage |
|-----------|-----------|----------|
| WS0 derived assets | T0 | file existence, size budget, transparency, approval |
| WS1 favicons/README/social | T1 | link tags, HTTP 200s, README render |
| WS2 web UI moments | T2 | avatar, empties, banner, i18n integrity, live e2e |
| WS3 landing/docs moments | T3 | bubbles, terminal icon, 404, wallpapers, weight |
| WS4 optional tail | T4 | explicit developer decision recorded |

## Test cases

### T0 — Derived assets

**T0.1 asset-inventory**
- Setup: WS0 script has run.
- Expected: `avatar-56.png`, `avatar-112.png`, `peek.png`, `mono.png`, `head-64.webp`
  exist in `docs/assets/mascot/` AND `public/assets/mascot/`.
- Assertions: each file ≤ 30 KB; PIL check `Image.open(f).mode == "RGBA"` (webp: has alpha);
  `avatar-56.png` is exactly 56×56.
- Edge cases: webp alpha actually preserved (some encoders drop it); mono variant still
  recognizable at 56px on both `#0d0d14` and `#f4f4f8` backgrounds.

**T0.2 contact-sheet-approval**
- Expected: a single preview sheet shown to the developer; explicit "approved" reply
  recorded in the session before any WS1–WS3 integration commit.

### T1 — Identity rollout

**T1.1 favicon-links-top-level**
- Setup: serve repo root; for each of `docs/guides.html`, `public/index.html`,
  `public/help.html`, `public/setup.html`, `public/codegraph-atlas.html`.
- Expected: page contains `<link rel="icon" type="image/png" sizes="32x32">` and
  apple-touch link; both hrefs resolve HTTP 200.
- Edge cases: relative path depth (`assets/` vs `../assets/`); help.html served from
  the Express app, not file:// — verify via the running server route.

**T1.2 subpage-inheritance (regression, should already pass)**
- Expected: every `docs/**/*.html` with a favicon link resolves it 200 against the
  updated `.ico`; `grep -rL favicon docs/*.html` finds no new pages missing one.

**T1.3 readme-render**
- Expected: `README.md` references the mascot via *relative* `docs/assets/mascot/` path;
  image renders on the GitHub repo page (manual eyeball after push); header stays under
  ~300px rendered height.

**T1.4 social-preview (manual)**
- Expected: developer confirms upload in GitHub Settings; link-paste into a Slack/Discord
  preview shows the robot card.

### T2 — Web UI

**T2.1 chat-avatar-live**
- Setup: isolated throwaway workdir + scratch DB, non-default port (no-stray-state rule);
  llama.cpp provider; send one message.
- Expected: AI reply bubble shows the robot avatar image (not letter "A"); user avatar
  unchanged.
- Assertions: `<img>` (or CSS background) resolves 200; Playwright: element screenshot
  diff against `avatar-56.png` non-empty match; no console 404s.
- Edge cases: long streaming reply — avatar doesn't reflow; dark and light themes.

**T2.2 roundtable-ring-identity**
- Setup: roundtable conversation with ≥2 agents.
- Expected: every agent bubble has the robot image AND retains its distinct ring color
  (`--agent-primary` vs `--agent-verifier`).
- Assertions: computed border/ring colors differ between agent avatars.

**T2.3 empty-states**
- Setup: fresh scratch DB, zero memories.
- Expected: sidebar memories list shows `mono.png` robot + existing i18n string; no `◈`.
- Assertions: no new `data-i18n` keys introduced (`git diff` on locales is empty for WS2);
  no raw-key text rendered (grep rendered DOM for `sidebar_` prefixed literals).
- Edge cases: state after first memory is added — robot yields to list without artifacts.

**T2.4 disconnect-banner**
- Setup: open UI, kill server process.
- Expected: offline banner appears with mono robot; reconnect restores UI; no image 404
  spam in console while offline (asset must be cached or inlined).

**T2.5 header-pages**
- Expected: `setup.html`, `help.html` show the head beside the title, aligned at mobile
  width 375px without wrap breakage.

### T3 — Landing & docs

**T3.1 mascot-bubble-component**
- Setup: serve `docs/`; check the three designated sections.
- Expected: exactly **three** `.mascot-bubble` instances on the page; each reuses an
  existing `data-i18n` key (assert: keys present in `docs/locales/en.json` *before* this
  plan's diff).
- Assertions: dark + light theme screenshots show readable bubble text; no horizontal
  scroll at 375px; tail renders on both themes.
- Edge cases: Bulgarian locale (`?lang=bg` uses DM Sans font override) — bubble doesn't
  clip longer Cyrillic strings.

**T3.2 terminal-demo-icon**
- Expected: provider row shows `head-64.webp` at 16px inline where `🤖` was; vertical
  alignment matches emoji baseline; i18n string untouched (emoji was outside the
  `data-i18n` span — verify).

**T3.3 404-page**
- Setup: local serve → `/nonexistent`; after deploy → `baiganio.github.io/aperio/nonexistent`.
- Expected: `docs/404.html` renders peek robot + "not in my memory" line + working link
  to `index.html`.
- Edge cases: GitHub Pages project-site 404 path quirks (assets must use absolute
  `/aperio/assets/...` or inline styles — relative paths break on nested 404 URLs).

**T3.4 wallpaper-strip**
- Expected: four links download the JPEGs (200, content-type image/jpeg); thumbnails lazy-load
  (`loading="lazy"`).

**T3.5 page-weight**
- Setup: Lighthouse or `curl`-sum of new assets referenced by `docs/index.html`.
- Expected: total *new* bytes on landing ≤ 60 KB beyond the already-shipped hero PNG.
- Edge cases: hero `robot-aurora-512.png` (259 KB) predates this plan — consider WebP
  swap as a bonus if budget is blown, don't count it against WS3.

**T3.6 reduced-motion**
- Expected: with `prefers-reduced-motion: reduce` emulated, no mascot animation plays
  anywhere (hero bob, bubble entrance, banner tilt-in).

### T4 — Decisions recorded

**T4.1 decision-log**
- Expected: session log / A2D.md contains explicit developer verdicts for: CLI ASCII
  banner (yes/no), mascot name "Meno" (yes/no/other). Deferred = logged in A2D, not lost.

## Test execution order

1. T0 (blocks everything)
2. T1, T2, T3 independently (T2 requires isolated live server; T3 requires docs serve)
3. T3.3 deploy-half and T1.3/T1.4 manual halves re-checked after push
4. T4 anytime before closing the plan

## Required setup

- Isolated run env per the no-stray-state rule: throwaway workdir, scratch `SQLITE_PATH`
  (set env **before** dynamic import — see memory `feedback-scratch-env-vars-before-import`),
  non-default port; tear down after T2.
- Playwright available (`tests/browser/` harness already in repo — reuse its fixtures).
- Chrome via claude-in-chrome for screenshot approvals.
- No commits until the workstream's screenshots are approved (Co-pilot Contract).

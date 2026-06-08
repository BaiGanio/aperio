# Aperio — Honest Audit

*Written 2026-06-05. Based on reading the code, tests, git history, and docs — not the marketing.*

You asked three real questions:

1. Is it worth continuing?
2. What actually outshines the competition?
3. You've lost the map — of features and of bugs.

I'll answer all three, bluntly. The short version up front:

> **Aperio is a real, technically impressive piece of software — not a toy. Its biggest problem is not quality; it's scope. You are building five products at once, alone, and that's why you feel lost and why nothing clearly "wins" against competitors. The path forward isn't more features. It's picking one and cutting the rest loose.**

---

## 1. What you've actually built (the map you lost)

This is bigger than it probably feels day-to-day. Concretely:

**Code size (hand-written, excluding deps):**
- `lib/` 10.8k LOC · `public/` 5.1k · `db/` 2.3k · `mcp/` 1.7k · `server.js` 557 · tests **~8.0k**
- ~21k LOC of product + 8k of tests. That is a substantial application, not a script.

**Activity:** 1,180 commits between 2026-03-09 and today — solo, in ~3 months. (More on what that pace signals below.)

**The feature surface — this is what you've lost track of:**

| Area | What exists |
|------|-------------|
| **Memory** | semantic + FTS recall, remember/update/forget, dedup by cosine, backfill embeddings, importance/expiry/tombstones |
| **Wiki** | LLM-authored cited articles, hybrid search, revisions, slugs |
| **Code graph** | tree-sitter symbol/call/import/extends extraction (JS/TS/JSX/TSX + more), live chokidar reindex, callers/callees walk, multi-repo |
| **Agent loop** | 4 providers (Ollama, Anthropic, DeepSeek, Gemini), tool-calling, skills matching, reasoning/thinking mode |
| **Round-table** | two-agent cross-review until `AGREED` or round cap |
| **MCP server** | **28 tools** exposed to any MCP client (Cursor, Windsurf, Claude…) |
| **Storage** | SQLite+sqlite-vec+FTS5 (zero-config default) **and** Postgres+pgvector, auto-detected |
| **Web UI** | streaming chat, themes, sessions (paginate/delete/persist), **24-language i18n**, code panel |
| **Terminal client** | standalone + proxy chat |
| **File/doc tooling** | read/write/edit/append/scan, xlsx/pptx/pdf/docx handlers, image preprocess + local VLM describe |

That table *is* your feature inventory. It belongs in the repo (see §6). The fact that it took an audit to assemble it is itself the finding.

---

## 2. Code health — better than you probably think

The fear is "the code is a mess held together by string." The evidence says otherwise:

- **Tests: 722 / 723 passing** (723 tests, 161 suites, ~8s). One failure: `tests/lib/helpers/shutdownGuard.test.js`. For a solo project this is genuinely strong discipline.
- **`.env` is *not* tracked** — no leaked secrets. `.env.example` is the only env file in git. Good.
- **Almost no inline rot:** only 2 `TODO/FIXME` markers in the whole codebase.
- **Clean refactor hygiene:** `lib/agent.js` is a 1-line re-export shim to `lib/agent/index.js` — a real refactor, not abandoned duplication.
- **CI is wired:** CodeQL, Codecov, SonarCloud, Codacy, Dependabot.

**This is not a project drowning in technical debt. It's a project drowning in surface area.** Different problem, different cure.

---

## 3. Where the "code depth" pain actually comes from

You said you get stuck in code depth. I found exactly where, and it's not random — it's structural:

1. **Four providers, three tool-schema dialects, in parallel.** `lib/agent/index.js` maintains `anthropicByName`, `ollamaByName`, and `geminiByName` tool maps side by side, plus provider-specific shaping of every request/response. Every new feature has to be threaded through all of them. This is the single biggest depth multiplier in the codebase. Each provider you support roughly multiplies the cost of every agent-loop change.

2. **`runAgentLoop` is a god-function.** It's the spine of `agent/index.js` (674 LOC) and carries skills, reasoning, tools, streaming, and abort handling at once. Hard to change without fear.

3. **Config sprawl.** Code reads **43 distinct `process.env` vars**; `.env.example` documents **19**. That's ~24 undocumented knobs. Every hidden flag is a branch you have to hold in your head — and a future you won't.

4. **Front-end is quietly becoming the heaviest part.** `public/scripts/streaming.js` (1,188), `public/index.js` (1,008), `lib/emitters/handlers/wsHandler.js` (725). A vanilla-JS UI at this size is its own maintenance burden competing for your time with the actual product (the memory layer).

5. **Small things that will calcify:** the `tests/lib/handlers/attatchments/` path misspelling ("attatchments") is now baked into directory structure and tests. `trash/` and `var/scratch` are in the tree. Versioning jumped `2.44.0` → `0.49.0` in the CHANGELOG — the version number no longer means anything, which makes "what shipped when" unanswerable.

None of these are fatal. Together they explain the feeling precisely: **the depth is the breadth, recursed.**

---

## 4. The competitive question — the honest answer

You asked what outshines competitors. Honest answer: **right now, nothing clearly does — and that's a positioning problem, not a quality problem.**

The space is crowded: mem0, Letta (MemGPT), Zep, Cognee, basic-memory, Supermemory, OpenMemory. Each wins by doing **one** thing recognizably well. Aperio's genuine, defensible edges exist:

- **Truly zero-config, single-file, self-hosted** (SQLite + sqlite-vec, one `var/aperio.db`). Most "self-hosted" competitors still want Docker, a vector DB, and a Postgres. Aperio's "clone, `npm i`, run, no keys" is real and rare.
- **Memory + wiki + code graph in one store.** The code graph alongside memory is an unusual, genuinely useful combination for coding agents.
- **Local-first by default** (Ollama + local embeddings, no data leaves the machine) — a real stance, not a checkbox.

But here's the trap: **those edges are diffused across so many features that no single one is legible to a newcomer in 10 seconds.** A visitor can't tell if Aperio is a memory API, a chat app, a wiki, a code-intelligence tool, or an MCP server — because it's all of them. Competitors win the first 10 seconds because they're one of them.

**You don't have a quality gap. You have a "what is this in one sentence" gap.**

---

## 5. Should you continue? — my actual recommendation

Yes, *if* you change how. Here's the reasoning, honestly:

- **Walking away wastes a real asset.** This isn't sunk-cost talk — 722 passing tests and a working 28-tool MCP server with zero-config local memory is something most people never finish. The foundation is sound.
- **But continuing the current way is unsustainable.** 1,180 commits in 3 months solo, a CHANGELOG that's mostly *Fixed:* entries, version numbers that reset — that's the signature of *thrashing*, not progress. You're running to stay in place because every change ripples through five products and four providers. That pace burns out solo maintainers; it's the most likely cause of the project dying, more than any technical issue.

**So: continue, but contract before you expand.** Concretely, in priority order:

1. **Pick the one-sentence wedge.** My recommendation based on what's actually strongest: *"Zero-config, single-file, local-first memory + code graph for MCP agents."* Drop everything that doesn't serve that sentence from the front page.
2. **Cut provider surface to two.** Keep Ollama (local-first identity) + one cloud (Anthropic). Move DeepSeek/Gemini behind a clearly "experimental/community" flag or remove. This alone removes the largest source of your code depth.
3. **Decide if the bundled Web UI is core or a liability.** 6k+ LOC of vanilla JS is half your maintenance. If the wedge is "memory for MCP agents," the UI is optional and could be frozen/minimized. That's the highest-leverage scope cut available.
4. **Don't add a feature for a release or two.** Spend that time on §6.

I'd stop short of telling you to keep all of it — the breadth is the disease, and more breadth is not the cure.

---

## 6. Reclaiming the map — concrete, do-this-week

You said you have no track of features or bugs. Fix that mechanically; it's a half-day:

- **`FEATURES.md`** — paste the table in §1. One source of truth for "what exists." Update it in the same PR that adds a feature, or it doesn't ship.
- **GitHub Issues as the bug ledger.** Stop carrying bugs in your head and in CHANGELOG "Fixed" lines. Every bug = one issue, labeled. This *is* the missing bug tracker. You already have the repo; you're just not using Issues as the log.
- **Fix the one failing test** (`shutdownGuard.test.js`) and make green-CI a hard gate. A solo dev's safety net is the test suite — keep it 100%.
- **Reconcile config:** document the 24 undocumented env vars in `.env.example`, or delete the dead ones. Likely several are dead.
- **Housekeeping:** remove `trash/` and `var/scratch` from the tree; pick a version scheme and stick to it (you're at `0.51.2` in package.json — just go forward from there and never look back at the `2.x` line).
- **Write a one-paragraph "what Aperio is NOT building" note** to yourself. The hardest solo-dev skill is saying no to your own ideas. Make the list explicit so future-you obeys it.

---

## Bottom line

Aperio is worth continuing. It is well-tested, secure, genuinely capable, and has at least one real edge (zero-config local-first memory + code graph). It is not failing on quality.

It is failing on **focus**. You feel lost because you've been the solo author of five products and four AI backends simultaneously, with no written map and no bug ledger. That's exhausting and it hides your own progress from you.

The move is not "build more so it finally wins." The move is **subtract until the value is legible in one sentence**, write down what exists, and let the test suite and Issues carry the load your memory has been carrying. Do that, and this becomes a tool you can sustain alone — which, for an open-source project, is the only kind that survives.

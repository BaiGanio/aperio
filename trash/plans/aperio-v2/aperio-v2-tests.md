# Aperio v2 — tests (verify-first)

Companion to `aperio-v2.md`. Run each group **before** its step and confirm it is red.
Then implement until it is green.

**TDD rule (locked):** every test here starts from a v1 test when one fits (see the Test Reuse Map in
the plan). It is copied from `archive/v1-final` and cut to v2 scope, with its edge cases kept.
If none fits, a new test is written. Every test must fail before its code exists. A ported test is never
weakened to pass. Any scope change is written down in the commit.

## Coverage map

| Plan step | Test group | Coverage |
|---|---|---|
| S0.1 | T0.1 clean start point | tree state, CI state recorded |
| S0.2 | T0.2 archive tag | tag on remote, readable from fresh clone |
| S0.3 | T0.3 feature ledger complete | every feature/tool/panel/skill has a status |
| S0.4 | T0.4 lessons ledger complete | tech-debt + feedback notes all captured |
| S0.5 | T0.5 issue triage | every open issue has one outcome |
| S0.6 | T0.6 reset plan retired | pointer present |
| S1.1 | T1.1 wipe | only keep list on v2; master untouched |
| S1.2 | T1.2 AGENTS.md | approved, rules present |
| S1.3 | T1.3 lint/CI teeth | one planted violation per anti-pattern guard AP1–AP9 fails |
| S2.1 | T2.1 eval harness + baseline | v1 baseline recorded, both models |
| S2.2 | T2.2 config | precedence, generator check |
| S2.3 | T2.3 store | CRUD, hybrid search, forget cleans vectors |
| S2.4 | T2.4 embeddings | round-trip, signature mismatch |
| S2.5 | T2.5 provider | streaming + tool calls, both models |
| S2.6 | T2.6 auto-recall | eval ≥ baseline |
| S2.7 | T2.7 auto-capture | inbox, nothing written without approval |
| S2.8 | T2.8 in-process tools | 5 tools called directly, ctx contract, no MCP dep |
| every S2.x / S3.x | T-SPEC spec gate | study + approved spec exist before first test/code commit |
| S2.9 | T2.9 file gate | traversal, symlink, TOCTOU |
| S2.10 | T2.10 skills | on/off eval delta |
| S2.11 | T2.11 WS schema | AP8: known types accepted, unknown/malformed rejected |
| S2.12 | T2.12 v1 → v2 import | no lost rows, v1 DB untouched |
| S3.1–S3.7 | T3.x UI parts | preview approved + Playwright |
| S4.1 | T4.1 daily use | 2 weeks, no open blocker |
| S4.2 | T4.2 done check | all green + ledger ported |
| S4.3 | T4.3 swap + install | fresh install runs core flow |
| Phase 5 | T5 return gate | eval delta per returning feature |

---

## Phase 0

### T0.1 — clean start point
- **Setup:** the other session has committed its store split.
- **Expected:** `git status --porcelain` shows no files from this plan's scope; `gh run list -b master -L 1` state written in the plan.
- **Assertions:** archive commit SHA recorded; CI state recorded (green, or red with named cause).
- **Edge cases:** other sessions' untracked files present → leave them, record them, do not stash.

### T0.2 — archive tag
- **Setup:** fresh clone into scratch dir.
- **Expected:** `git show archive/v1-final:FEATURES.md` and `git show archive/v1-final:lib/routes/paths.js` print content.
- **Assertions:** tag is annotated; tag SHA == T0.1 SHA; tag exists on `origin`.
- **Edge cases:** a lightweight tag by mistake → fail; tag pushed before CI state known → fail.

### T0.3 — feature ledger complete
- **Setup:** script lists `## ` headings of `FEATURES.md`, files in `mcp/tools/`, panel scripts in `public/scripts/`, dirs in `skills/` — all at the tag.
- **Expected:** each listed item appears in `feature-ledger.md`.
- **Assertions:** zero missing items; every status ∈ {core, later, parked, never}; every `later`/`never` row has ≥1 v1 path; self-memory row = `parked`.
- **Edge cases:** an item in two groups (e.g. docgraph tool + panel) → both rows, same status; renamed files → ledger uses tag path.

### T0.4 — lessons ledger complete
- **Setup:** list open items in `id/reference/tech-debt.md` and all `feedback_*.md` memory notes.
- **Expected:** each has a lesson line or ledger link.
- **Assertions:** zero unmatched items; each lesson has a source link.
- **Edge cases:** a tech-debt item that is a feature gap, not a lesson → goes to feature ledger, still counted.

### T0.5 — issue triage
- **Setup:** developer-approved triage table.
- **Expected:** after applying, `gh issue list --state open` shows only `v2-carry` / `v2-later` labelled issues.
- **Assertions:** every issue from the 2026-10-30 list (22) has exactly one outcome; every closed one has the template comment; every `carry → close` item has its content in ledger or eval design first.
- **Edge cases:** a new issue opened during triage → triaged too; issue reopened by someone → re-check.

### T0.6 — reset plan retired
- **Assertions:** first lines of `aperio-reset.md` link to `aperio-v2.md`; edited only after its in-flight work is committed.

## Phase 1

### T1.1 — wipe
- **Assertions:** `git ls-tree -r --name-only v2` ⊆ keep list (`LICENSE`, `CHANGELOG.md`, `docs/**`, `trash/**`, `.gitignore`, `.github/**`, `README.md`) + new v2 files; `master` HEAD unchanged; main folder still on `master`; `.env` and `var/` untouched.
- **Edge cases:** `docs/` site build still passes on `v2` (gh-pages workflow).

### T1.2 — AGENTS.md
- **Assertions:** contains "the one rule", scope line, port protocol (9 rules), small-model budgets, return gate; Co-pilot Contract intact; developer approval noted.

### T1.3 — lint/CI teeth (anti-pattern guards AP1–AP9)
- **Setup:** a fixture folder `tests/guards/fixtures/` with one bad file and one good file per guard. The guard test runs the linter and scripts on them.
- **Expected red (one per guard):**
  - AP1 `process.env.FOO` in `src/agent/x.js`
  - AP2 `if (provider === "llamacpp")` in `src/agent/x.js`
  - AP3 `import fs from "node:fs"` in `src/tools/x.js`
  - AP4 `readFileSync(` in `src/agent/x.js`
  - AP5 `try { f() } catch {}` and `.catch(() => {})` with no `// cleanup` marker
  - AP6 module-level `const c = new Map(); c.set(...)` outside `boundedMap`
  - AP7 a 600-line file with no `// size-reason:` header
  - AP9 `src/server.js` + `src/http/server.js`
- **Expected green:** `process.env` in a Tier-0 allowlisted file; `readFileSync` in `src/boot/`; `.catch(() => {}) // cleanup`; a constant `new Set([...])` with no mutation; a 600-line file with `// size-reason:`.
- **Assertions:** each red case fails with the guard's id (`AP1`…`AP9`) in the message; each green case passes; the guard suite runs in CI on every push to `v2`.
- **Edge cases:** a guard disabled by an `eslint-disable` comment → CI fails unless the comment names an AP id and a reason.

### T2.11 — WebSocket message schema (AP8)
- **Assertions:** client and server import the same schema module; every known message type validates; an unknown type is rejected with an error frame; a known type with a wrong field type is rejected; the server never reaches the switch with an unvalidated message; a malformed JSON frame does not crash the socket.

## Phase 2

### T-SPEC — spec gate (runs for every S2.x and S3.x step)
- **Setup:** `trash/plans/aperio-v2/specs/<step>.md` made from `specs/_template.md`.
- **Assertions:** the v1 study section is filled (files, best parts, bad parts, lessons, v1 tests table); the spec section has goal, behaviour, interface, errors, limits, non-goals; every acceptance item maps to a named test case; zero open questions; status line says **approved <date>**; the approval date is earlier than the step's first test or code commit (`git log`).
- **Edge cases:** the spec changed during the build → it is re-approved before the code commit that depends on it; a spec over 2 pages → the step is split.

### T2.1 — eval harness + baseline
- **Setup:** fixture `evals/memories.json` (~30 memories, dated across weeks), `evals/scenarios/*.json` (multi-turn: fact set in turn 1 of session A, used in session B without a hint), tool-call cases.
- **Expected:** harness runs against v1 (from the tag, isolated scratch DB, non-default port) and later v2, same fixtures.
- **Assertions:** baseline per model recorded in `evals/baseline.json`: recall precision@5, "used without hint" rate, tool-call success, p95 + max turn latency.
- **Edge cases:** model returns empty completion (gemma quirk) → retried, counted; scratch state cleaned after run; no thresholds invented — v2 targets = v1 baseline.

### T2.2 — config
- **Assertions:** DB overlay beats env beats default (`db` mode); `env` mode flips it; Tier-0 key ignores DB; unknown key rejected; `.env.example` regen is idempotent.

### T2.3 — store
- **Assertions:** create/read/update/delete; FTS hit; vector hit; hybrid ranks a doc that matches both above one matching only one; `forget` removes the vector row (v1 orphan bug); migration on empty DB and re-run is no-op.
- **Edge cases:** unicode/Cyrillic text; 10k memories search under budget (measured, not assumed); concurrent writes.

### T2.4 — embeddings
- **Assertions:** embed → store → search finds itself top-1; signature stored per row; changing model flags rows for reindex; no network call.

### T2.5 — provider
- **Setup:** both test models via llama.cpp, isolated port.
- **Assertions:** streams tokens; parses tool calls (incl. known malformed shapes from v1); bad tool JSON is reported back, never silently `{}`; context size taken from GGUF header.
- **Edge cases:** server not started; model mid-load; abort mid-stream frees resources.

### T2.6 — auto-recall
- **Assertions:** on both models: "used without hint" rate ≥ v1 baseline; recall precision@5 ≥ baseline; injected block stays within token budget; prompt prefix (system + tool schemas) byte-identical across turns.
- **Edge cases:** zero relevant memories → nothing injected; 1000 memories → still budget-bound.

### T2.7 — auto-capture
- **Assertions:** candidate facts land in inbox, not in `memories`; approve moves it; reject drops it; auto-approve rule works; duplicates merged.
- **Edge cases:** secrets in text (API key pattern) → never proposed.

### T2.8 — in-process tools
- **Assertions:** the agent loop runs remember → recall → update → list → forget in-process on both models; each tool exposes name + JSON schema + `run(args, ctx)`; `ctx` shape snapshot test; invalid args return a clear error to the model (not `{}`); `package.json` has no MCP SDK dependency; no child process is spawned for tools.

### T2.9 — file gate
- **Assertions deny:** `../` escape; symlink pointing outside; absolute path outside; symlink swapped between check and use; path with null byte.
- **Assertions allow:** normal file inside allowed folder.
- **Carry:** Windows ARM path cases from #528.

### T2.10 — skills
- **Assertions:** for each of the 4 skills: eval with skill on vs off; on ≥ off on both models; each skill's token cost logged.

### T2.12 — v1 → v2 import
- **Setup:** a copy of the developer's real v1 SQLite DB in scratch (never the original). If it is encrypted, decrypt the copy only.
- **Assertions:** v1 row count == v2 row count (minus documented skips, each with a reason); title/content/tags/dates equal on a random sample of 50; recall finds 10 known old facts; the v1 file's sha256 is the same before and after.
- **Edge cases:** an empty DB; rows with NULL fields; Cyrillic text; very long content; a re-run is idempotent (no duplicates).

## Phase 3

### T3.x — UI parts (one per part)
- **Setup:** standalone preview HTML in scratch.
- **Assertions:** developer approved the preview; integrated part matches it; Playwright test covers it (chat: send + stream + stop; memory table: view/edit/delete; inbox: approve/reject; settings: change a key and see it applied; theme + font scale persist).
- **Edge cases:** phone width; dark mode; no localStorage.

## Phase 4

### T4.1 — daily use
- **Assertions:** 14 days logged in `A2D.md`; zero open blockers.

### T4.2 — done check
- **Assertions:** all suites green; eval ≥ baseline on both models; every `core` ledger row has a "Ported in" commit; line count of `src/` + `public/` recorded.

### T4.3 — swap + install
- **Setup:** clean container / VM.
- **Assertions:** `master` == merged `v2`; release v1.0.0 on `release`; fresh install starts, loads a test model, remember → new session → recall-without-hint works; gh-pages site updated.
- **Edge cases:** user upgrading from v0.69.4 with an existing DB → clear message or migration (decide at S4.3).

## Phase 5

### T5 — return gate
- **Assertions per returning feature:** ledger row → mini-plan exists → eval case shows the need → score after > score before → no core eval regresses.

---

## Test execution order

T0.1 → T0.2 → (T0.3, T0.4 in parallel) → T0.5 → T0.6 → T1.1 → T1.2 → T1.3 →
**T2.1 (baseline) before any other T2** → T2.2 → T2.3 → T2.4 → T2.5 → (T2.6, T2.7, T2.8, T2.9 in any order) → T2.10 → T2.11 → T2.12 →
T3.x → T4.1 → T4.2 → T4.3 → T5 (repeating).

## Required setup

- `gh` CLI with repo rights (tag, labels, issues).
- Worktree `../aperio-v2`; main folder stays on `master`.
- Both test models in `var/models/`; llama.cpp binary.
- Scratch dir for v1 baseline runs (isolated DB, non-default port, cleaned after).
- Playwright for T3.x.
- Clean container/VM for T4.3 (Docker smoke is enough).

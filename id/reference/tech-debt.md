# Known Tech Debt

Two kinds of entry live here. **Running Code Depth** (below) is the live log of what we hit
while working and what is still hanging or unfixed — dated, grouped by topic, deleted the
moment it is fixed or promoted to an issue/plan; it mirrors the `A2D.md` convention. The
**curated tables** further down are intentional, long-lived deferrals and
investigated-and-rejected findings — do not "fix" those without discussion.

Code depth only — what we hit, what is still broken. Suggestions, recommendations, and
housekeeping go in `A2D.md`, not here.

## Running Code Depth

> **Convention (mirrors `A2D.md`):** topic-headers with dated lines under them. An entry is
> deleted immediately once it is fixed or promoted to a GitHub issue or a plan — this is a
> live worklist, never a graveyard. The dates are how we tell what is what.

### Format

```markdown
## <Topic / Area>

- <YYYY-MM-DD> <what we hit / what's hanging> — <impact or why it's unfixed>
```

<!-- Add topic sections below as they come up (e.g. ## Codegraph, ## Migrations, ## Providers). -->

## Embeddings

- 2026-07-30 `initEmbeddings`'s legacy startup backfill loop (`lib/helpers/embeddings.js`,
  the `[...memPending, ...wikiPending, ...selfPending]` loop) reads `row.content` uniformly,
  but SQLite's `wiki.listWithoutEmbeddings()` returns `body_md`, not `content` — every wiki
  article backfilled through this path (not through the new #287 reindex driver, which was
  fixed) embeds `"Title. undefined"`. Pre-existing, found while fixing the same bug in
  `lib/embeddings/reindex.js`'s wiki adapter; out of scope for that fix.

- 2026-07-30 Ordinary (non-reindex) embedding writes — `rememberHandler`/`updateMemoryHandler`,
  `selfRememberHandler`/`selfUpdateHandler`, the import backfills, the retry queues, and
  `initEmbeddings`'s startup backfill — persist whatever the writing process's own
  `EMBEDDING_PROVIDER` produces with no check against the target store's `vec_meta` status or
  signature. `isVectorSearchable()` gates reads but nothing gates writes, so in Postgres's
  multi-agent mode a still-on-the-old-config process can land a foreign-space vector on a row
  during another process's reindex clear→settle→finalize window; the row then has *a* vector,
  drops out of the reindex driver's pending scan, and the store finalizes `current` with a
  mixed embedding space the existing store-level signature check can't detect. Review finding
  (P1) against `lib/embeddings/reindex.js:409-410`, but the fix belongs on the write side
  (~8 files, none in the #287 branch's current diff) — tracked as issue #340.

## Codegraph / docgraph watchers

- 2026-07-30 `startWatcher()` in `lib/codegraph/watcher.js` / `lib/docgraph/watcher.js` has no
  dependency-injection point (`indexRepo`, the embed queue, `generateEmbedding` are all
  module-level imports) and the returned handle exposes only `{ root, stop }` — no way to
  observe the embed queue's contents or force its 5s unref'd flush timer. This blocked a
  direct regression test for the #287 review fix that gates the startup embedding backfill
  behind `pendingStoreNames()` (skip when the reindex driver already owns the store), and for
  its follow-up refinement (only defer when the root already existed before this indexRepo
  call — a brand-new root can't have been in the reindex driver's already-captured
  `listRepoRoots()` snapshot for its current run, so it must always self-embed regardless of
  overall store status). Both fixes reuse patterns already covered by `initEmbeddings`'s and
  the reindex driver's own tests; only the watcher-level call site is unverified by an
  automated test. A real test would need either
  an injectable embed-queue/flush hook on the watcher, or a slow (~5s) timer-driven wait.

## Test harness

- 2026-07-29 The aggregate `npm test` runner makes real-app WebSocket T45 load-sensitive:
  the second of three overlapping chats sometimes completes instead of being interrupted
  when all 4,816 tests run concurrently. The intended `test:e2e:real` suite passes 85/85 at
  concurrency 2, including T45, but two aggregate runs reproduced the failure. Stabilizing
  the overlap barrier or bounding aggregate concurrency is outside issue #338.

---

## Intentional deferrals

These are intentional deferrals. Do not "fix" them without discussion.

| Item | Status | Blocked on |
|------|--------|------------|
| CSP headers disabled | Resolved: Helmet CSP is enforced by default; use `APERIO_CSP=report` for rollout diagnostics | — |
| `tree-sitter` pinned at `^0.24.7` | Cannot upgrade to 0.25+ (ABI 15) | `tree-sitter-wasms` must ship ABI-15 grammar builds |
| `coding-examples` skill stub | Merged into `coding-standards`, but the old `SKILL.md` still exists as a "do not load" redirect | Cleanup pass on skills directory |

## Investigated and rejected

Not deferrals — these were built, measured, and found not to work. Do not re-attempt the same
approach without new evidence; a different mechanism may still be worth trying.

| Item | Finding | Evidence |
|------|---------|----------|
| Memory compaction via deterministic filler-phrase rewriting (issue #286, `/caveman-compress` borrow) | Real Aperio memory content contains no removable conversational filler — 0.00% token savings measured against both the capability-exam corpus and every real row in the dev DB. Content is terse, third-person, LLM-extracted fact/decision prose, not chat-log/verbose-note text the technique targets. Confirmed independently via gzip compressibility (real content compresses worse than filler-laden control text of the same length). A model-based paraphrase pass was considered and rejected on cost/latency grounds for content this short (a few sentences per memory); might be worth revisiting only if memory content shape changes to hold much longer text (paragraphs/documents). | CHANGELOG.md Unreleased entry, issue #286 closing comment |

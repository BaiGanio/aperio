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

## Codegraph

- 2026-07-24 (#283) Every panel that follows the `csp-style-2` (hidden-by-default) +
  `panel().style.display !== "none"` toggle pattern (codegraph, docgraph, wiki, db, …)
  swallows its first click after page load: the class hides via CSS `display:none` but the
  JS toggle reads the *inline* style, which starts as `""` (not `"none"`), so the first click
  is treated as "already open" and closes a no-op. Second click actually opens it. Found while
  testing the codegraph Map overlay. Fix would be checking computed style or an explicit
  `data-open` flag instead of inline `style.display`; touches every panel using the pattern,
  so out of scope for the current change.

- 2026-07-24 (#283) `loadGraph(store, repoId)` reads the *entire* repo graph into memory on
  every `code_neighbors`/`code_path`/`code_insights`/`/graph` request. Fine at the 10k-node
  target and matches the "shared adapter loads one repository" design, but a depth-1 neighbors
  query still materializes the whole repo. If large-repo latency bites, add a bounded
  DB-side BFS fast-path for shallow neighbors, or cache the built graph per (repoId,
  graph_revision) so warm traversals skip the reload. Not urgent.

## Providers

- 2026-07-24 `MODEL_FACTS` in `lib/providers/index.js` is a hand-maintained hardcoded
  dictionary. Every new model needs a manual entry or it falls through to
  `GENERIC_MODEL_FACTS` (8 GB weights, 512 KB/token KV) which is wildly pessimistic —
  guesstimates ~25 GB per model instead of the GGUF header's real 2-4 GB. `resolveModelFacts`
  already reads real GGUF metadata from cached files, so the curated dict is a stale
  bottleneck: models that haven't been downloaded yet can't be inspected, but once cached
  the dict is redundant. Should be replaced with a DB table or `.env`-driven overrides keyed
  by HF repo path, falling back to `inspectCachedModel` for anything local and only using
  GENERIC_MODEL_FACTS as a last resort for truly uncached remote refs. Affects:
  context-window sizing, RAM-usage readouts, model-tier benchmarks, and roundtable budget.

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

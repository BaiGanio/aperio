# future-llm-wiki.md

Roadmap for Aperio's LLM Wiki, after the MVP (`wiki_write` + `wiki_get` + `003_wiki.sql`).
Items are ordered by expected value, not effort.

## Near-term (next obvious cuts)

- **`wiki_search`** — FTS + vector hybrid over `wiki_articles`, mirroring the `recall` handler.
  Without it, the model can only fetch by known slug and will rebuild articles it doesn't realize already exist.
- **`wiki_list`** — filter by `tag`, `status`, `updated since`. Needed for any UI surface.
- **Auto-regenerate on `wiki_get` when stale.** Today the MVP returns a warning; once we have a "synthesize" loop
  (skill calling `recall` → `wiki_write`), `wiki_get(..., refresh=true)` can drive it server-side.
- **Skill file** — `skills/wiki/SKILL.md` with the trigger rules sketched in the design conversation
  (when to read vs. when to write, "never invent facts not in sources", slug immutability).

## Mid-term

- **`wiki_link_graph(slug, depth)`** — parse `[[slug]]` out of `body_md` into an `wiki_links` edge table
  (or compute on demand). Enables "related articles", orphan detection, and a sidebar graph view.
  Only build this once there are >20 articles; before that, in-body links are enough.
- **Citation rendering** — resolve `[[mem:<uuid>]]` markers to memory titles at read time so the body
  reads naturally without requiring the LLM to duplicate the title in prose.
- **Per-article `lang`** so the FTS trigger can pick the right Postgres config (currently hardcoded to `'simple'`).
  Mirrors what `memories` already does via `localeToPgConfig`.
- **Soft-delete / archive workflow** beyond the `archived` status — keep slug reserved so dead links don't silently 404.

## Longer-term / speculative

- **Drift detection beyond source_hash.** The hash catches *cited* memory changes. It does not catch new memories
  on the same topic that should have been cited. A periodic job could re-run `recall(topic)` per article and flag
  articles whose candidate-source set has diverged materially.
- **Diff view between revisions.** Store prior `body_md` (separate `wiki_article_revisions` table) so the user
  can see what the model changed on a refresh. Karpathy's framing leans heavily on revision transparency.
- **Multi-user / shared wikis.** Aperio is single-user today. If that changes, articles need an `owner_id`,
  visibility scope, and a conflict model for concurrent edits — substantially more design than the MVP assumes.
- **Export to static site.** `wiki_articles` → markdown files → publish under `baiganio.github.io/aperio/wiki/...`.
  Cheap once `wiki_list` exists.
- **Confidence/quality scoring.** Borrow `confidence` from `memories`; articles inherit a floor from their
  least-confident source. Surface low-confidence articles for human review.

## Things deliberately NOT planned

- **Per-read regeneration.** Too expensive, too drifty. Articles are a cache; refresh is a discrete event.
- **A separate embeddings model for articles.** Reuse `generateEmbedding` — divergence here would break
  cross-search between memories and articles.
- **A graph database.** A `wiki_links` table in Postgres covers every realistic query for a personal wiki.

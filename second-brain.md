# second-brain.md

## The idea, explained like you're five

Imagine you have a **magic notebook**.

Every time you tell it something — "my dog's name is Pixel", "I like blueberry pancakes", "the kitchen light is broken" — it remembers. Not just the words. It remembers what the thing *means*, so later you can ask "what's broken in the house?" and it knows the kitchen light counts, even though you never said the word "broken house."

That's the **memory box**. Aperio already has it.

But the memory box has a problem. If you ask "tell me everything about my dog," the notebook has to dig through a hundred little sticky notes — "Pixel likes treats," "Pixel barks at the mailman," "Pixel's birthday is in June" — and read them all, every single time. That's slow. And if a small robot friend is helping (a smaller AI model), it might get tired and forget half of them.

So we make a second thing: a **storybook**.

The storybook has one neat page per topic. One page about Pixel. One page about the broken kitchen light. One page about pancakes. The robots **write the storybook themselves** by reading the sticky notes and squishing them into a tidy story. At the bottom of every page they write **"I learned this from sticky note #7 and #12"** — so you can always check.

When a sticky note changes ("Pixel's birthday is actually in July!"), the page about Pixel gets a little 🟡 sticker that says *"this might be wrong now, please redo me."* Next time someone reads it, a robot fixes it.

That's the **second brain**. The sticky notes are the truth. The storybook is the fast, friendly version the robots read out loud.

---

## What we want to build next (in kid words, then grown-up words)

### 1. Teach the storybook to find its own pages

**Kid:** Right now the robot can only open a page if it already knows the page's name. That's silly — it should be able to flip through and find pages about "dogs" even if it forgot the page is called "pixel-the-dog."

**Grown-up:** `wiki_search` — hybrid FTS + pgvector over `wiki_articles`, mirroring the `recall` handler. Same embedding model so memory-search and wiki-search live in the same semantic space.

**Why it matters first:** without it, every model silently *rebuilds* articles that already exist. That's the single biggest leak in the current MVP.

**How to build it:**
- Copy `recall`'s query shape; swap the table.
- Return `[{slug, title, summary, score, status}]` — no body, the caller decides whether to `wiki_get`.
- Weight `fresh` higher than `stale`; never return `archived`.

**Value:** ~1 hour of work. Every model from ollama to opus stops duplicating work. Token spend drops the day it ships.

---

### 2. Give the storybook a table of contents

**Kid:** A list of every page, sorted by which one we changed last. So you can see what's in the book without opening every page.

**Grown-up:** `wiki_list({tag?, status?, updated_since?})` — paginated, ordered by `generated_at DESC`.

**Why:** every UI needs it. Every "what do I have written about X tag" question needs it. Cheap.

**How:** straight SQL, no embeddings, no FTS. Ten-line handler.

**Value:** unlocks step 3. On its own, also lets the model answer "do we have an article about deployment?" in one tool call.

---

### 3. A tiny window into the storybook (real UI)

**Kid:** Right now nobody can *see* the storybook except the robots. We should put a little window in the app so you can read it too.

**Grown-up:** read-only panel in the existing Aperio sidebar — article list (from `wiki_list`) + markdown render of `body_md`, with `[[mem:uuid]]` resolving to memory titles and `[[slug]]` becoming internal links.

**Why:** today the wiki is invisible. The `SKILL.md` breadcrumb hack ("🔖 From wiki:…") exists *only* because there's no UI. Once a UI exists, the breadcrumb becomes optional and the wiki feels real.

**How:**
- Reuse the memories sidebar component shape from commit `3208747`.
- No editing in v1 — that's a trap. Editing means conflict resolution with the model's writes.
- Click a `[[slug]]` → load that article. Click `[[mem:uuid]]` → open the memory in the existing memories view.

**Value:** the user finally *sees* the second brain. Trust goes up. You'll spot bad articles you'd never have noticed.

---

### 4. Let stale pages fix themselves

**Kid:** When a page has the 🟡 "this might be wrong" sticker, asking to read it should just *quietly redo it* using the freshest sticky notes. You shouldn't have to ask twice.

**Grown-up:** `wiki_get(slug, refresh=true)` triggers a server-side regenerate path: `recall(article.title + summary)` → re-draft `body_md` → `wiki_write` with new `source_hash`. Pick the cheapest available provider for the rewrite (ollama or deepseek), not whichever model happens to be in the user's chat.

**Why:** this is where multi-model Aperio earns its keep. Refresh is a background-y job; it should never block on opus.

**How:**
- New flag on `wiki_get`. If `status='stale'` and `refresh=true`, route through the agent loop with a *fixed* small-model provider.
- Old revision goes into `wiki_article_revisions` (the future table from the roadmap) — but only ship that table *with* this feature, not before.

**Value:** the storybook self-heals. The user never sees a stale page unless they explicitly ask for the old version.

---

## Why a *second brain* beats just-more-memories

| Thing                       | Memory box (sticky notes)    | Storybook (wiki)                 |
| --------------------------- | ---------------------------- | -------------------------------- |
| What it stores              | Tiny atomic facts            | Synthesized pages about a topic  |
| Who writes it               | The user (mostly)            | The LLM, citing memories         |
| How it stays true           | User edits                   | Auto-stale trigger + regenerate  |
| Cost to read one topic      | 10–20 recalls + reasoning    | One `wiki_get`                   |
| Good for small/local models | Painful — they re-synthesize | Great — they read pre-chewed     |
| Hallucination risk          | Low (raw facts)              | Low *if* citations are enforced  |

The wiki is **not a replacement** for memories. It's a **cache of expensive synthesis**, with the invariant *"every claim must trace back to a cited memory."*

---

## Karpathy's pitch vs. what Aperio does

Andrej Karpathy's "LLM wiki" sketch (the Obsidian-vault version) goes roughly like this:

1. Keep a markdown vault on disk.
2. Let the LLM read and *write* notes in it.
3. Notes cite their sources.
4. The vault is the long-term memory.

Where **Aperio matches** the spirit:

- ✅ LLM-authored articles (`wiki_write`)
- ✅ Inline citations (`[[mem:<uuid>]]` + `wiki_article_sources` join table)
- ✅ One article per concept; update-in-place with a `revision` counter
- ✅ A skill (`skills/wiki/SKILL.md`) that teaches every model when to read vs. write
- ✅ A roadmap toward revisions, link graph, drift detection

Where **Aperio outshines** the Obsidian-vault version:

- 🏆 **Source-of-truth integrity.** Postgres foreign keys mean a memory can't quietly disappear and leave a citation dangling. A markdown vault has no referential integrity.
- 🏆 **Automatic staleness.** A trigger on `memories.UPDATE` flips dependent articles to `stale`. Obsidian has no equivalent — staleness lives in the user's head.
- 🏆 **Hybrid search out of the box.** FTS + pgvector on both `memories` and `wiki_articles`, same embedding space. Obsidian needs a plugin for semantic search and even then doesn't share an embedding space with your memory layer.
- 🏆 **Multi-model native.** Refresh can be routed to whichever provider is cheapest *right now* — deepseek for bulk regen, opus for tricky merges. A vault-on-disk approach has no notion of "which model wrote this revision."
- 🏆 **Single backup surface.** `pg_dump` snapshots everything: memories, articles, citations, embeddings, in one consistent transaction. Vault snapshots can split-brain against an embeddings sidecar.

Where **Karpathy's version still wins** (and why we're okay losing those):

- 🥈 **Human editability.** Obsidian is a beautiful editor; the wiki has no editor yet. *Acceptable* because step 3 above (the read-only UI) closes most of the gap, and editing-with-conflict-resolution against an LLM author is a real research problem we don't need to solve.
- 🥈 **Portability.** Markdown files in git are forever. Postgres rows feel less archival. *Mitigated* by the "export to static site" item on the roadmap — one-way export gives you the archive benefit without the dual-write headache.
- 🥈 **Plugin ecosystem.** Obsidian has thousands of plugins. We have zero. *Acceptable* because the plugins solve problems we don't have (graph view → we'll build one; daily notes → that's memories; templates → that's the SKILL).

---

## The order to build, one more time

1. `wiki_search` — stops duplicate writes today.
2. `wiki_list` — unlocks UI and tag/status questions.
3. Read-only sidebar UI — makes the second brain visible and trusted.
4. `wiki_get(refresh=true)` with cheap-model routing — closes the staleness loop and shows off multi-provider Aperio.

Everything else on `future-llm-wiki.md` — revisions, link graph, drift detection, multi-user — waits until there are >20 articles and a real reason. Building those earlier is *designing for a wiki you don't have yet.*

---

## One-sentence summary for the fridge

> Aperio's memories are the sticky notes. The wiki is the storybook the robots write from them — and unlike a folder full of markdown files, ours can tell when a page has gone stale and fix itself.

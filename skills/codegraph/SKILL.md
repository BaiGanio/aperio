---
name: codegraph
description: >
  Use this skill when navigating, understanding, or changing code in an indexed
  repo. Prefer the code graph (symbol search, source slices, call graph) over
  full-file reads and wide greps — it is cheaper and more precise. Covers when
  to reach for which tool and the canonical lookup sequence.
metadata:
  keywords: "code search, find function, where defined, where is, what calls, callers, callees, refactor, impact analysis, symbol, navigate code, codebase tour, qualified name, outline, indexed repo, project path, which repo, what repos, what project, go to project"
  category: "code-navigation"
  load: "on-demand"
---

# Code Graph

A pre-indexed symbol + call graph over the user's repos, exposed as six MCP tools:
`code_repos`, `code_search`, `code_outline`, `code_context`, `code_callers`, `code_callees`.

Reach for these **before** `read_file` or recursive grep whenever the question is about a symbol (function, class, method, const, type) or its relationships.

---

## Mandatory rule — project paths and repo locations

**ALWAYS call `code_repos` before answering any question about:**
- A project's path or location on disk
- Which projects/repos are indexed
- Whether a repo exists or is available

Project paths are runtime filesystem facts — they are NOT in your training data and you CANNOT answer them from knowledge. Never guess or refuse. Always call `code_repos` first.

This rule overrides the general "don't use tools for knowledge questions" guidance in agent-conduct. A project path is not a knowledge question.

## When to use

- "Where is `X` defined?" → `code_search` → `code_context`
- "What does this file contain?" → `code_outline`
- "Show me the body of `Foo.bar`" → `code_context`
- "What calls this?" / "Who depends on this?" → `code_callers`
- "What does this touch?" / "What's downstream?" → `code_callees`
- Before changing a function's signature or semantics → `code_callers` first
- "Give me a tour of this codebase" → `code_repos` → `code_outline` on entry files
- Any time you'd otherwise read a 500-line file to find one function

## When NOT to use

- File is not in an indexed repo (check with `code_repos` first if unsure)
- Language not covered by the extractor (today: JS / TS / JSX / TSX only — see *Extending* below)
- Symbol was just created in this session and isn't indexed yet → fall back to `read_file`
- Prose, configs, data files — those belong to `wiki`, `memory`, or `read_file`
- Whole-file context legitimately matters (e.g. understanding module-level side effects, import order)

---

## Canonical flow

```
unknown repo  → code_repos     (which repos are indexed, where are they)
unknown name  → code_search    (returns ranked qualified names + kinds)
known file    → code_outline   (cheap map before fetching context)
known symbol  → code_context   (source slice with leading comment + padding)
about to edit → code_callers   (one hop; depth ≤ 5 for transitive)
tracing flow  → code_callees   (one hop; depth ≤ 5 for transitive)
```

A typical "find and read" is two calls: `code_search` → `code_context`. A typical "safe-to-change" check is one more: `code_callers`.

---

## Qualified names

`code_search` returns results keyed by **qualified name**: `<repo-relative path>::<Class>.<method>` or `<path>::<function>`. Pass that string verbatim to `code_context`, `code_callers`, `code_callees`. Do not reconstruct it by hand.

Examples:
- `lib/agent/index.js::Agent.run`
- `mcp/tools/files.js::readFile`

## Repos are part of every result

Multiple repos can be indexed at once, and paths/qualified names are **repo-relative** — `lib/playground.js` may exist in several of them. Every match from `code_search`, `code_outline`, `code_callers`, and `code_callees` therefore carries its repo:

- `repo` — the repo's short name (root_path basename), e.g. `aperio`
- `root_path` — the repo's absolute path, e.g. `/Users/lk/Projects/BaiGanio/aperio`

**Never infer which repo a relative path belongs to from the path itself** — that guess is the source of cross-project hallucinations. Read `repo`/`root_path` straight off the result. To open the file directly, join `root_path` + the relative `path` and `read_file` that absolute path.

When you act on a result, pass its `repo` to the follow-up tool (`code_context`, `code_outline`, `code_callers`, `code_callees`) so the lookup resolves in the right repo. Without it, a qualified name or path that exists in two repos resolves to an arbitrary one. If a `repo` substring matches more than one indexed repo the tool errors with the candidates — pass a longer substring.

---

## Common patterns

**Bug triage.** User reports "X is broken." → `code_search` the user's wording → `code_context` the top hit → `code_callers` to find the entry path that triggered it.

**Refactor scoping.** Before renaming or changing a signature: `code_callers` at `depth: 2` or `3` to see the blast radius. If it's large, propose a plan to the user before editing.

**Codebase tour.** `code_repos` → pick the relevant repo → `code_search` for likely entry symbols (`main`, `run`, `start`, `register`, `handler`) → `code_outline` on each hit's file.

**"What does this function actually do?"** `code_context` for the body → `code_callees` to see what it delegates to → recurse one level on anything non-obvious.

---

## Gotchas

- **Stale index.** If `code_context` returns *"file not found — repo may have moved"*, the index is out of date. Tell the user; suggest `node lib/codegraph/indexer.js <path>` to reindex.
- **Hybrid search ranking.** `code_search` blends FTS with semantic embeddings when available. Short, distinctive terms (function names, error strings) rank best. Long natural-language queries work too but return broader results — narrow with `kind` or `repo`.
- **Depth cap.** `code_callers` / `code_callees` cap at depth 5. For wider sweeps, walk iteratively and summarize.
- **Padding.** `code_context` defaults to 2 lines of padding above/below the symbol. Bump to 5–10 when you need surrounding context (imports, sibling helpers).
- **JS/TS only today.** Other languages fall through to file reads until extractors are added.

---

## Extending to more languages

The extractor is `lib/codegraph/extract-ts.js` and uses `web-tree-sitter` with `tree-sitter-wasms`. Adding a language means: register the grammar, write a small node-type walk that yields `{ name, kind, qualified, startLine, endLine, leadingDoc }`, and (optionally) extract call edges by walking call expressions.

Grammars already installed and ready to wire up: `python`, `go`, `rust`, `java`, `kotlin`, `c`, `cpp`, `c_sharp`, `ruby`, `php`, `swift`, `scala`, `lua`, `bash`, `solidity`, `dart`, `elixir`, `zig`, plus markup (`html`, `css`, `vue`), data (`json`, `yaml`, `toml`), and query languages (`ql`).

If a user asks about a language not yet supported, say so plainly and fall back to `read_file` / grep — do not silently miss results.

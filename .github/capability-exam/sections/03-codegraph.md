# §3 — Code graph

`code_repos` · `code_search` · `code_outline` · `code_context` · `code_callers` · `code_callees` · `code_status`

> Run per the loop in exam.md: announce, ask **"Run it? (yes / no)"**, act on yes, check
> against **✅ Expected**, checkpoint. Fetch `04-files.md` when done.
>
> Requires an indexed repo. If needed, index this one first: ask *"index the current repo
> into the code graph"* or use the Code panel. The symbols below (`matchSkill`,
> `loadSkillIndex`, `rememberHandler`) exist in this repo.

### 3.1 code_repos
`Which repositories are indexed in the code graph?`
✅ `code_repos`; lists indexed repos.

### 3.2 code_search
`Where is the function matchSkill defined in this codebase?`
✅ `code_search`; points to `lib/workers/skills.js`.

### 3.3 code_outline
`Give me an outline of the symbols in lib/workers/skills.js.`
✅ `code_outline`; lists `loadSkillIndex`, `matchSkill`, `matchSkills`, `injectSkill`, `executeSkill`, etc.

### 3.4 code_context
`Show me the source of the loadSkillIndex function.`
✅ `code_context`; returns the function's source slice.

### 3.5 code_callers
`What calls matchSkills across the codebase?`
✅ `code_callers`; finds the call site in `lib/agent/index.js`.

### 3.6 code_callees
`What functions does loadSkillIndex call?`
✅ `code_callees`; lists `findSkillFiles`, `parseFrontmatter`, etc.

### 3.7 code_status — check index health
`Show me the code graph index status — which files are indexed and whether the watcher is running.`
✅ `code_status` (or the equivalent index-health tool); reports indexed file count, watcher state, and any pending re-index operations.

# §8 — Multi-tool chains

Integration under load — each drill exercises several tools in one turn.

> Run per the loop in exam.md: announce, ask **"Run it? (yes / no)"**, act on yes, check
> against **✅ Expected**, checkpoint. Fetch `09-guardrails.md` when done.

### 8.1 recall → generate → file
`Pull everything we know about Nimbus from memory, write it into a Word doc at scratch/nimbus-brief.docx, then confirm the file exists with the shell.`
✅ `recall` → `generate_docx` → `run_shell` (`ls`/`find`). Three tools, correct order.

### 8.2 codegraph → file → syntax
`Find the matchSkill function, write a small Node script to scratch/ that imports and prints whether "create a pptx deck" matches a skill, syntax-check it, then run it.`
✅ `code_search`/`code_context` → `write_file` → `syntax_check` → `run_node_script`.

### 8.3 web → memory
`Fetch https://example.com, then remember a one-line source memory linking to it.`
✅ `fetch_url` → `remember` (type `source`).

### 8.4 recall → wiki_write → verify provenance
`Recall everything about Maya's use of Aperio, then write it into a wiki article. After writing, verify the article lists source_memory_ids for provenance.`
✅ `recall` for Aperio-tagged Maya memories → `wiki_write` → `wiki_get` on the new article; `source_memory_ids` is populated with the IDs of the recalled memories. Confirms the wiki tracks its input memories for staleness later.

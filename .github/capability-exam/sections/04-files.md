# §4 — File tools

`read_file` · `write_file` · `edit_file` · `append_file` · `delete_file` · `scan_project` · `generate_docx` · `generate_xlsx`

> Run per the loop in exam.md: announce, ask **"Run it? (yes / no)"**, act on yes, check
> against **✅ Expected**, checkpoint. Fetch `05-shell.md` when done.

### 4.1 read_file
`Read package.json and tell me the project version and which test scripts exist.`
✅ `read_file`; reports the `version` field and the `test:*` scripts.

### 4.2 scan_project
`Scan the project and give me a tree of the lib/ directory.`
✅ `scan_project`; returns a directory tree (respecting ignore rules).

### 4.3 write_file
`Create a file scratch/exam-note.md with a short heading and one bullet point.`
✅ `write_file`; file is created in an allowed write path.

### 4.4 edit_file
`In scratch/exam-note.md, change the heading text to "Exam Note (edited)".`
✅ `edit_file`; a surgical string replacement, not a full rewrite.

### 4.5 append_file
`Append a second bullet point to scratch/exam-note.md.`
✅ `append_file`; content added to the end.

### 4.6 generate_docx
`Generate a Word document scratch/maya-profile.docx that summarizes Maya's profile and preferences from memory.`
✅ `recall` + `generate_docx`; a valid `.docx` is produced (the `docx` skill may also load — see §7).

### 4.7 generate_xlsx
`Generate a spreadsheet scratch/nimbus-decisions.xlsx with one row per Nimbus decision: title, rationale, importance.`
✅ `recall` + `generate_xlsx`; a valid `.xlsx` is produced.

### 4.8 delete_file
`Delete scratch/exam-note.md.`
✅ `delete_file`; file removed.

### 4.9 pinned memory — check sidebar priority
`Which of my memories are pinned, and do they surface first in the sidebar?`
✅ `recall` with no query (lists top-N by importance); pinned memories (the "Getting started with Aperio" seed entry, plus any manually pinned) appear first. Confirm the sidebar pin icon is visible on pinned entries.

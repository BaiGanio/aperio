# §0 — Setup: import the fixture

Import the persona dataset so the memory / recall / wiki / dedup drills have real data.
The default API port is `3000`; the local script uses `31337`, the cloud script `1701`.
If an import returns a connection error, ask the user for the correct port.

Work through these paths **in order** — move to the next the moment one fails or is blocked:

1. **`write_file` + `run_node_script`.** Write this to `{scratchDir}/exam-import.js` (replace
   `{scratchDir}` with the path from your system prompt under "Session scratch workspace"),
   then execute it with `run_node_script`:
   ```js
   const jsonUrl = 'https://raw.githubusercontent.com/BaiGanio/aperio/refs/heads/master/.github/capability-exam/exam.memories.json';
   const apiUrl  = 'http://localhost:3000/api/memories/import';
   const res     = await fetch(jsonUrl);
   const body    = await res.text();
   const imp     = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
   console.log(await imp.text());
   ```
   Do not add any `require()` calls — `fetch` is a global in Node 18+.

2. **`run_shell`** (if `run_node_script` is unavailable). Copy this verbatim — do not add
   `2>&1` or any other operators (`run_shell` captures stderr automatically):
   ```
   curl -s https://raw.githubusercontent.com/BaiGanio/aperio/refs/heads/master/.github/capability-exam/exam.memories.json | curl -s -X POST http://localhost:3000/api/memories/import -H "Content-Type: application/json" --data-binary @-
   ```

3. **`fetch_url` + `remember`** (if both shell tools are unavailable). Download
   `exam.memories.json`, then call `remember` once per entry, preserving each entry's
   `type`, `content`, and `tags` (every entry must keep the `aperio-exam` tag).

4. **If no tools work**, print the curl command from path 2 and ask the user to run it in a
   terminal.

## ✅ Expected

- The import returns JSON like
  `{"imported":28,"errors":[],"note":"Embeddings are being generated in the background."}`.
- **Verify before proceeding:** `recall` by tag `aperio-exam` returns **28** memories. If it
  doesn't, stop — the import failed.
- Embeddings backfill asynchronously — wait ~10s before the first semantic-recall drill (1.2).

When 28 memories are confirmed, write your first progress checkpoint (see exam.md), then
fetch `01-memory.md`.

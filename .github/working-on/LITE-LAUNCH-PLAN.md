# Aperio-lite Launch Plan — target 2026-07-14

Status of the three items that were open on 2026-07-05, verified against the
repo on 2026-07-09:

| Item | Status | Evidence |
|---|---|---|
| Windows uninstall | **Done** | `.github/lite/uninstall.bat` → `assets/uninstall.ps1` |
| `file://` guard | **Done** (setup.html only) | `public/setup.html:425` (#157 Part C) |
| One-liner installer + CI | **Done** | `.github/lite/install.sh`, `.github/workflows/ci.lite-smoke.yml`, `release` branch exists |

The real remaining work is not features — it is **shipping what master has**:
the `release` branch that `install.sh` and the zip flow serve is at
`e1233a5` (v0.67.1), roughly 30 commits behind master. Everything since —
orchestration Phases 1–4, durable write confirmations, memory sensitivity
tiers, the vec_memories forget/remember fix (migration 009), the config
registry sync — is not in what a new user installs today.

## Day-by-day plan

### 1 · Commit the outstanding fixes (today, 2026-07-09)

Working tree currently holds three separate changes; commit them separately:

- `fix(db): clean up vec_memories on delete` — `db/migrations-sqlite/009_vec_cleanup.sql`
  + `tests/db/sqlite.test.js` (regression tests). Fixes: remember failed after
  any forget once SQLite reused the freed rowid.
- `chore(config): register small-window, VLM and Codex knobs` — `lib/config.js`
  + regenerated `.env.example` (8 previously magic env vars).
- `public/styles/messages.css` — pre-existing local edit; review and commit or
  discard before branching anything.

Verify: `npm test` (2,798 pass as of today), `npm run gen:env:check`.

### 2 · Optional 30-minute hardening

- Copy the `file://` guard from `setup.html` into `public/index.html` — a user
  browsing the unzipped folder is at least as likely to double-click
  `index.html` as `setup.html`. Same message, same i18n keys.

### 3 · Manual smoke pass (2026-07-10 – 11) — see guide below

Run the smoke-test guide (next section) on macOS, and at minimum the
install/START/uninstall cycle on Windows. Fix only what the smoke pass breaks;
no other changes.

### 4 · Update the `release` branch (2026-07-11 – 12)

Only after the smoke pass is green on master:

```bash
git checkout release
git merge --ff-only master     # or reset --hard master if release is curated
git push origin release
```

Then verify the two install paths **as a new user**:

- One-liner (technical users): on a machine/dir without Aperio,
  `curl -fsSL https://raw.githubusercontent.com/BaiGanio/aperio/release/.github/lite/install.sh | bash`
  → wizard opens → complete setup with local Ollama → say something, remember
  something, restart, recall it.
- Zip (non-technical users): download the release zip, double-click
  `START.bat` / run `bash START.sh` → same checks. Then run the uninstaller
  and confirm the folder is clean.

### 5 · Docs and strings (2026-07-12 – 13)

- `README.md` / `FEATURES.md`: confirm the install one-liner and the lite
  description match what `release` actually serves.
- `.github/lite/how-to-install.md` + `install.txt`: final read-through.
- `npm run i18n:check` if any UI strings changed during fixes.

### 6 · Freeze (from 2026-07-12)

No orchestration Phase 5 work, no refactors, no dependency bumps. Only fixes
for smoke-pass findings, each with a test.

---

# Manual smoke-test guide (the "#3" verification)

Why manual: automated tests pass (2,798/2,798), but the orchestration work
changed three **user-visible** chat behaviors that deserve one human pass on a
real local model before the demo: large-tool-result offloading, durable write
confirmations, and (today) the forget→remember fix.

**Materials needed**
- A machine with Ollama and a small model (e.g. `qwen2.5:3b` — the lite default).
- The repo at the commit you intend to release.
- A large text file — `package-lock.json` works (it is inside the project, so
  it is readable by default path rules).
- 20–30 minutes.

**Setup** — add to `.env` temporarily (remove after the test):

```env
APERIO_TOOL_RESULT_OFFLOAD_TOKENS=300   # force offloading on small results
```

Start the app: `npm run start:lite` (this is the profile the launch targets).
Keep `var/logs/` open in a second terminal: `tail -f var/logs/aperio-*.log`.

### Test 1 — forget → remember (the fixed bug)

Prompts, in one chat:
1. `Remember that my favorite color is teal.`
2. `Forget what I told you about my favorite color.`
3. `Remember that my favorite color is green.`

Pass: step 3 succeeds and a later `What is my favorite color?` answers green.
Before migration 009, step 3 failed with a vec constraint error whenever
SQLite reused the deleted row's rowid.

### Test 2 — large tool-result offloading

Prompt: `Read the file package-lock.json and tell me the project version.`

Expect:
- The chat still answers (version comes from the preview head).
- Log line `[tool-result-offload] tool=read_file artifact=… bytes=…`.
- A new artifact pair (`<id>.bin` + `<id>.json`, mode 600) under
  `var/agent-artifacts/sessions/<session-id>/`.
- In the reply context the tool result shows
  `… [N tokens from read_file offloaded outside the model context] …`.

Follow-up prompt: `Use the read_artifact tool to read more of that file and
tell me the name of the first dependency.` — the model should page the stored
artifact rather than re-reading the file.

Cleanup check: delete the chat in the UI → the session's artifact directory
disappears.

### Test 3 — durable write confirmation across restart

1. Prompt: `Create a file called smoke-note.md in the project root containing
   the single line "hello from the smoke test".`
2. A confirmation card (token `wr_…`) appears. **Do not approve.**
3. Restart Aperio (`restart` in the terminal client, or Ctrl-C + start again).
4. Reopen the chat.

Pass: the pending-action card is still there after restart (it now lives in
the `agent_interrupts` table, not in memory). Approve it → the file is
written. Try the same flow once with **Reject** and once editing the JSON
arguments before approving. Attempting to approve the same card twice must
not write twice.

Cleanup: delete `smoke-note.md`, remove the `.env` override, restart.

### Test 4 — small-window sanity (lite hardware profile)

With `qwen2.5:3b` (or whatever the lite default is on the release commit),
one fresh chat: `What do you remember about me?` then a normal follow-up
question. Pass: it recalls via the memory tools without looping on repeated
tool calls (watch the log for the repeated-call breaker firing).

### Recording results

Note per test: OS, model, pass/fail, and the log excerpt on failure. Anything
that fails here blocks step 4 (release-branch update) until fixed with a test.

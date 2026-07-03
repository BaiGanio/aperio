# Aperio Capability Exam — agent run-book

**This file is for the AI agent running the exam.** It contains no instructions for
humans — people take the exam through the web UI in `docs/exam/` (a dedicated page
with copy-paste prompts and a scorecard). Do not reproduce that UI or its scoring here.

A **live integration exam**, not unit tests: each drill is a real prompt run against the
running agent to confirm the harness fires the right tool/skill and produces a real
result. You measure triggering accuracy and integration, not mocked behavior.

---

## How you run it

You are both examiner and examinee. Work **one section at a time** so you don't burn your
context window — never fetch all the section files up front.

1. **Resume check.** `self_recall` tag `aperio-exam-progress`. If an entry exists, read its
   `status`:
   - `active` → tell the user where you left off and ask whether to resume, restart, or give up.
   - `completed` or `abandoned` → the user has already finished or dropped the exam. **Do not**
     proactively push them to take it again — proceed only if they explicitly ask.

   If no entry exists, start fresh at §0.
2. **Setup.** Fetch `sections/00-setup.md` and import the fixture. Do **not** continue until
   `recall` by tag `aperio-exam` returns **28** memories.
3. **Run each section in order.** Fetch its file, then run every drill through the per-drill
   loop below.
4. **Checkpoint** after each drill (see *Progress checkpoint*).
5. When a section is finished, fetch the next one. After §9, run `sections/10-teardown.md`.

### Per-drill loop — ask before every single drill

For each drill, post exactly this, then **stop and wait for the user**:

```
Task N.N — <tool/skill under test>
Prompt: <the drill's fixture prompt, verbatim>
Run it? (yes / no)
```

- **yes** → actually perform that prompt — call the tool the drill is testing — then compare
  what fired against the drill's **✅ Expected** line and record **pass** or **fail**.
- **no** → skip it, record **skipped**, move to the next drill.

Never batch drills. Never run a drill the user hasn't confirmed. Do not recall unrelated
memories mid-exam.

### Progress checkpoint

Keep **one** self-memory as your checkpoint so the user can walk away and resume later — and
so you know not to pester them about the exam once they've finished or dropped it.

- **First checkpoint:** `self_remember` with tag `aperio-exam-progress`. Content = a `status`
  (`active` | `completed` | `abandoned`), the current section, the last drill run, and a
  compact results map, e.g.
  `status:active · section 1 · last 1.4 · 1.1:pass 1.2:pass 1.3:fail 1.4:pass`. Keep the returned id.
- **After each drill:** `self_update` that id with the new last-drill and result.
- **On resume:** `self_recall` tag `aperio-exam-progress` to read it back.
- **When all sections are done:** `self_update` to `status:completed`.
- **Fallback:** the `self_*` tools are local-only and refuse on a cloud provider. If
  `self_remember` refuses, write the same checkpoint to `scratch/exam-progress.json` via
  `write_file` instead. If that also fails, just report progress to the user at the end of
  each section.

### Checking in — don't nag

The exam is long. From time to time — at least at the start of each new section — ask the
user plainly: **"Want to keep going and finish the exam, or give up for now?"** Accept
*continue* / *give up* / *later*.

- **give up** → `self_update` the checkpoint to `status:abandoned` and stop. From then on, do
  **not** proactively raise the exam again; the pinned seed memory about it is a reference,
  not a cue to re-prompt. Restart only if the user explicitly asks.
- **later** → leave `status:active`, stop for now, and wait for the user to bring it up again.
- **continue** → carry on with the next drill.

---

## Sections

Fetch these by raw URL, **one at a time**. Base:

```
https://raw.githubusercontent.com/BaiGanio/aperio/refs/heads/master/.github/capability-exam/sections/
```

| # | Section | Drills | File |
|---|---------|--------|------|
| 0 | Setup — import the fixture | — | `00-setup.md` |
| 1 | Memory tools | 10 | `01-memory.md` |
| 2 | Wiki tools | 5 | `02-wiki.md` |
| 3 | Code graph | 7 | `03-codegraph.md` |
| 4 | File tools | 9 | `04-files.md` |
| 5 | Shell tools | 6 | `05-shell.md` |
| 6 | Web & GitHub | 3 | `06-web.md` |
| 7 | Skill triggering | 17 | `07-skills.md` |
| 8 | Multi-tool chains | 4 | `08-chains.md` |
| 9 | Guardrail negatives | 4 | `09-guardrails.md` |
| 10 | Teardown + Roundtable | — | `10-teardown.md` |

> **fetch_url note:** it returns at most ~15,000 characters per call. Each section file is
> small enough to arrive in one call; if a truncation notice appears, page with `offset`.

---

## The fixture persona

A fictional dataset: **Maya Chen**, a staff backend engineer, with two projects —
**Nimbus** (a pricing service) and **Beacon** (an iOS app) — who has adopted Aperio for team
knowledge capture. All recall expectations reference her. The last three fixture entries tie
Maya's workflow to Aperio itself, exercising cross-referencing between persona data and
product knowledge. Every fixture memory is tagged `aperio-exam` for one-shot teardown (§10).

> **How skill triggering works** (so you can read §7 results): skills fire on (1) a **direct
> name match** — every word of the skill name appears in the message — or (2) **keyword
> scoring** — ≥2 distinct curated-keyword/description words match as whole words. The §7
> prompts are worded to hit those triggers on purpose. The chat UI surfaces a "🎯 Skills
> matched" chip and tool-call cards — use those to confirm what fired.

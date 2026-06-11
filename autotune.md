# autotune — self-tuning skill triggering for Aperio

**autotune keeps Aperio reaching for the right skill.** Every Aperio skill declares
trigger keywords; as the skill library grows, those keywords drift and collide, so the
assistant sometimes loads the *wrong* skill — or none at all. autotune tests the real
skill matcher against a set of realistic prompts and automatically tunes the keywords to
fix mismatches, **without breaking the ones that already work.**

It's modeled on [Andrej Karpathy's `autoresearch`](https://github.com/karpathy/autoresearch):
a mutate → score → keep/discard loop. The difference is the metric here is *deterministic*
— it calls Aperio's actual matcher (`lib/workers/skills.js`), no LLM and no network — so
"did this change help?" is a clean, instant, reproducible signal.

---

## Who it's for

This is a **maintainer tool, not an end-user feature.**

- **Operators / skill authors** invoke it (usually `/loop autotune`) to keep skill
  triggering healthy.
- **End users never trigger it** — they just notice the assistant "gets it" more often.
- The payoff is largest for **weaker / local models** (deepseek, qwen, ollama), which lean
  hardest on accurate triggering. Capable models often infer the right skill regardless;
  smaller ones need the keywords to be right.

> Think of it as **SEO for your skills** — tuning how discoverable each skill is to the matcher.

---

## When to run it

- After **adding a new skill** — does the matcher actually fire it for the phrasings real
  people use?
- When a skill **"doesn't work"** — usually the matcher never loaded it; reproduce the
  phrasing and tune.
- As a **regression check** after editing any skill's keywords — skills compete for slots,
  and widening one can silently steal another's.
- **Periodically** as the library grows and keyword collisions accumulate.

## What you do afterward

A run leaves three artifacts:

1. **A branch `autotune/<tag>`** with the committed keyword changes — review the diff and
   **merge it** to ship the improvement to users.
2. **The ledger `var/autotune/results.tsv`** — what was tried, kept vs discarded, and
   whether holdout improved.
3. **Discarded experiments** are reverted, so the working tree stays clean.

**Do not merge** if `holdout` stalled while `train` rose — that's overfitting (see Red flags).

---

## How it works

| Piece | Role |
|-------|------|
| `skills/autotune/eval.json` | The cases. `set:"exam"` mirror the capability exam §7 (kept green); `set:"hard"` are realistic paraphrases that deliberately dodge the curated keywords (several fail at baseline — that's the work). **Read-only ground truth.** |
| `skills/autotune/eval.holdout.json` | Hidden validation cases. The loop must **not** open them; the scorer reports their accuracy separately to catch overfitting. |
| `skills/autotune/score.mjs` | The evaluator. Prints `train` / `holdout` / `kwChars` and the failing cases. `--log` appends a ledger row. |
| `skills/autotune/SKILL.md` | The loop instructions (mutate → score → keep/discard), driven by `/loop`. |
| `var/autotune/results.tsv` | The ledger. Lives under `var/` (gitignored) — a persistent record, invisible to `git status`. |

**The metric, in one line:** `train` accuracy is what you optimize (higher is better);
`kwChars` (total keyword characters) is the simplicity tiebreaker (lower is better); `holdout`
is the honesty check you *watch but never optimize*. The only thing the loop ever edits is the
`description` / `metadata.keywords` frontmatter of other skills.

---

## Try it yourself (no server required)

**Prerequisites:** clone the repo and Node 18+. Run every command from the repo root.
(`2>/dev/null` just hides the one-line `📚 Skills indexed` log so you see only the scores.)

```bash
git clone https://github.com/BaiGanio/aperio.git
cd aperio
```

### Test 1 — Baseline smoke test (does it run?)

```bash
node skills/autotune/score.mjs 2>/dev/null
```

**Expected:**
- `train: 0.7308  [exam 18/18, hard 1/8]`
- `holdout: 0.5  [3/6]   (not optimized — overfitting check)`
- `kwChars: 2646`
- a `train failures:` list of 7 cases and a `holdout failures:` list of 3.

✅ **Looking for:** it prints scores without error, `exam` is **18/18** (the existing exam
suite is intact), and `hard` is **below 8/8** (there's real work for the loop to do). If
`exam` is not 18/18, a skill's keywords regressed — investigate before tuning.

### Test 2 — Prove the metric is live (break it, watch it drop)

A metric that's always 1.0 is useless. Confirm it reacts:

```bash
# Temporarily gut one skill's keywords
perl -0pi -e 's/  keywords: "pptx, presentation.*pptxgenjs"/  keywords: "pptxgenjs"/' skills/pptx/SKILL.md
node skills/autotune/score.mjs 2>/dev/null | head -3
# Revert
git checkout -- skills/pptx/SKILL.md
node skills/autotune/score.mjs 2>/dev/null | head -3
```

✅ **Looking for:** the first score shows `exam 17/18` (case 7.1 `pptx` now fails — it
matches `docgraph` instead), and after the revert it's back to `exam 18/18`. That proves
edits to skill keywords move the number.

### Test 3 — Run ONE tuning iteration by hand (watch the loop work)

The core mechanic: fix a failing case, confirm the score rises, decide keep/discard. `wiki`
is a clean example — it currently has **no keywords at all**, so both its `hard` and
`holdout` cases fail.

Edit `skills/wiki/SKILL.md` and add this under the `description:` block, before the closing `---`:

```yaml
metadata:
  keywords: "wiki article, knowledge base, knowledge base page, knowledge page, curated knowledge, write a wiki page, publish a knowledge page"
```

Then re-score:

```bash
node skills/autotune/score.mjs 2>/dev/null | head -3
```

✅ **Looking for THREE things:**
1. **`train` went up** — `0.7308 → 0.7692` (hard `1/8 → 2/8`). The fix worked.
2. **`holdout` ALSO went up** — `0.5 → 0.6667` (`3/6 → 4/6`). You never touched the holdout
   case `ho.wiki`, yet it flipped to passing. **This is the signal you most want to see** —
   the keywords generalize to phrasings the loop never saw, rather than memorizing one prompt.
3. **`exam` stayed 18/18** — no regression elsewhere. (`kwChars` rose 2646 → 2775; the cost,
   acceptable for +1 train and +1 holdout.)

All three hold → this is a **keep**. If `train` had risen but `holdout` dropped, that's
overfitting — discard. Revert the demo when done:

```bash
git checkout -- skills/wiki/SKILL.md
```

### Test 4 — The ledger (where results live)

```bash
node skills/autotune/score.mjs --log keep --desc "baseline" 2>/dev/null
cat var/autotune/results.tsv
```

✅ **Looking for** a tab-separated row:

```
ts                        branch          commit   train_acc  holdout_acc  kw_chars  status  description
2026-06-11T13:20:00.000Z  autotune/jun11  d280174  0.7308     0.5          2646      keep    baseline
```

- `branch` is the **session id**: every tuning run is its own `autotune/<tag>` branch, so
  each row tells you which run produced it; `ts` orders rows across runs. (On `master` the
  branch column reads `master` — a one-off score, not a loop session.)
- The scorer writes it for you (you never hand-format TSV). It's gitignored, so `git status`
  stays clean while the file is right there to `cat`. Want it in git? `git add -f var/autotune/results.tsv`.

### Test 5 — Run the autonomous loop

```
/loop autotune
```

It branches (`autotune/<date>`), reads the failures, fixes one skill per iteration,
re-scores, keeps (commit) or discards (`git checkout`), and logs each step. It's
**interruptible** — stop it anytime; it is *not* the "never stop" loop from Karpathy's original.

✅ **Looking for, as it runs:**
- `train` trending **up**, `exam` staying **18/18**.
- `holdout` trending up *with* train (generalizing), not flat while train climbs (overfitting).
- The ledger growing one row per experiment; honest `discard` rows are healthy, not failures.
- It **stops** when `train` hits 1.0 or plateaus — it should not contort keywords to squeeze
  the last case.

---

## Red flags (when to distrust a result)

- **`train` up, `holdout` down or flat** → overfitting. Keywords satisfy only the visible
  prompts. Revert; prefer phrasings a real user would type.
- **`exam` drops below 18/18** → a tuning edit broke a previously-passing skill (one skill got
  greedy enough to steal another's first-place slot). The global scorer catches this every
  run — discard the change.
- **`kwChars` ballooning for tiny `train` gains** → complexity creep. A 1-case gain needing a
  long keyword list usually steals a co-load elsewhere; check the failure count actually dropped.

---

## Extending it — add your own cases

The eval sets are just JSON. To make the loop fix a phrasing that matters to you:

1. Add a case to `skills/autotune/eval.json` under `cases` (use `set:"hard"`):
   ```json
   { "id": "hard.myskill", "set": "hard", "prompt": "the natural phrasing a user types", "expect": "the-skill-name-that-should-fire" }
   ```
   Use `"expectNot": ["skill-a","skill-b"]` instead of `"expect"` for a negative case (those
   skills must never appear).
2. Optionally add a *paraphrase* of the same intent to `eval.holdout.json` — that's how you
   measure whether a fix generalizes.
3. Re-run `node skills/autotune/score.mjs`. New failing cases give the loop something to fix.

**Never** edit `eval.json`, `eval.holdout.json`, `score.mjs`, or `lib/workers/skills.js`
*during* a tuning run — they are the metric. The only editable surface is other skills'
keyword frontmatter.

---

## Cleanup

```bash
rm -rf var/autotune                 # remove the ledger
git branch -D autotune/<date>       # only if a tuning branch was created
```

---

## How skill matching works (background)

The matcher (`matchSkills` in `lib/workers/skills.js`) picks skills two ways:
1. **Direct name match** — every word of the skill's name appears in the message.
2. **Keyword scoring** — a skill with curated `metadata.keywords` must hit ≥1 keyword and
   score ≥2 distinct whole-word matches across its keywords + description.

autotune optimizes exactly this: it adds the discriminating keywords a realistic prompt needs,
while the global scorer guards against any one skill becoming greedy enough to steal another's
slot. That's the whole game.

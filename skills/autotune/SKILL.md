---
name: autotune
description: >
  Use this skill to iteratively tune the keywords and descriptions of other
  SKILL.md files so the skill matcher fires the right skill for a prompt.
  Runs an autonomous mutate → score → keep/discard loop against a frozen eval
  set (exam §7 skill triggering), advancing a git branch when match accuracy
  improves. The eval and scorer are read-only ground truth; the curated keyword
  frontmatter of other skills is the only editable surface.
metadata:
  keywords: "tune skill keywords, autotune skills, optimize skill triggering, improve skill matching, skill match accuracy, skill keyword tuning, retune skill descriptions"
  category: "meta-tooling"
  load: "on-demand"
---

# Skill Autotune

## What this is / who it's for

**autotune keeps Aperio reaching for the right skill.** Each skill declares trigger
keywords; as the library grows, those keywords drift and collide, so the assistant
sometimes loads the wrong skill — or none. autotune tests the matcher against a set
of realistic prompts and automatically tunes the keywords to fix mismatches, without
breaking the ones that already work.

This is a **maintainer tool, not an end-user feature.** Only whoever curates the skill
library ever invokes it (typically `/loop autotune`); regular users never trigger it —
they just notice the assistant "gets it" more often. The payoff is largest for the
weaker/local models (deepseek, qwen, llamacpp), which lean hardest on accurate triggering.

- **When to run it:** after adding a new skill, when a skill "doesn't fire" for a
  phrasing users actually use, or as a regression check after editing any keywords.
- **What you do afterward:** review the keyword diff on the `autotune/<tag>` branch and
  **merge it** to ship the improvement; read `var/autotune/results.tsv` for what was
  tried (kept vs discarded). Don't merge if `holdout` stalled while `train` rose — that's
  overfitting; add more realistic cases and rerun.

Think of it as **SEO for your skills** — tuning how discoverable each skill is to the matcher.

---

A self-improving loop (modeled on Karpathy's `autoresearch`) that tunes skill
**triggering** by editing keyword/description frontmatter and scoring against the
real matcher. The metric is deterministic — no LLM, no network — so keep/discard
is a clean signal.

## Roles (do not confuse them)

- **Read-only ground truth** — `skills/autotune/eval.json` (the cases) and
  `skills/autotune/score.mjs` (the scorer). These define the metric. **Never
  edit them during a run**, and never edit `lib/workers/skills.js` (the matcher).
- **Hold-out set** — `skills/autotune/eval.holdout.json`. **Do NOT open this
  file or tune toward it.** The scorer reports holdout accuracy separately so you can
  tell genuine improvement from overfitting.
- **Editable surface** — the `description` and `metadata.keywords` fields of any
  `skills/*/SKILL.md`. That is the *only* thing you change.
- **Ledger** — `var/autotune/results.tsv` (gitignored runtime dir, persists across
  runs). Written by the scorer's `--log` flag (see below) — don't hand-format TSV rows.

## Metric

`node skills/autotune/score.mjs` prints:

- `train` — accuracy over `eval.json` (exam + hard cases). **This is what you optimize**
  (higher is better), with a per-set breakdown.
- `holdout` — accuracy over the hidden set. Watch it: if `train` climbs while `holdout`
  stalls or drops, you are overfitting — back off.
- `kwChars` — total curated-keyword characters across all skills (**lower = simpler**).
- `failures` — each shows `expect` vs `got`, so you know exactly what to fix.

## Setup

1. **Run tag**: propose one from today's date (e.g. `jun11`). Branch
   `autotune/<tag>` must not already exist.
2. **Branch**: `git checkout -b autotune/<tag>` from current master.
3. **Read context**: `eval.json` and `score.mjs` (so you know the cases and the
   rules), plus the SKILL.md frontmatter of the skills named in the failing cases.
4. **Baseline**: run the scorer once, unmodified, and log it:
   `node skills/autotune/score.mjs --log keep --desc "baseline"`.
5. Confirm setup looks good, then begin.

## What you CAN do

- Edit `metadata.keywords` and `description` in any `skills/*/SKILL.md`.

## What you CANNOT do

- Edit `eval.json`, `score.mjs`, or `lib/workers/skills.js` — that is the metric.
- Change a skill's `name`, `load`, `category`, or `depends-on`.
- Add, remove, or rename skills.

## The experiment loop

Paced by `/loop autotune` — **interruptible**, not "never stop". One
experiment per iteration:

1. Read the `train failures` from the last score run. Pick **one** skill to adjust
   (usually the `expect` skill of a failing case, or the one wrongly winning a slot).
2. Edit that skill's `keywords`/`description` by hand — a targeted change, not a
   rewrite. Prefer adding the few discriminating words the failing prompt actually
   uses over dumping synonyms.
3. Run `node skills/autotune/score.mjs`.
4. **Keep** if `train` rose (and `holdout` did not drop) — `git add -A && git commit`
   with a one-line message. Also keep an edit that holds `train` steady at **lower
   kwChars** (a simplification win). Then log it:
   `node skills/autotune/score.mjs --log keep --desc "what you changed"`.
5. **Discard** if `train` is equal-or-worse (and kwChars not lower), or if `holdout`
   regressed: `git checkout -- skills/` to revert, then
   `node skills/autotune/score.mjs --log discard --desc "what you tried"`.

## Simplicity criterion

All else equal, fewer keywords is better. Equal accuracy at lower kwChars → keep.
A one-case gain that needs a pile of broad keywords usually **steals a slot from a
co-loading skill** elsewhere — the scorer runs every case each time, so check that
the `failing cases` count actually dropped before keeping. If a change fixes one
case but breaks another, net accuracy won't move: discard it.

## Overfitting guard

You are optimizing a 17-case proxy, not real agent quality. Do not invent keywords
that only exist to satisfy a single eval prompt — keywords must be phrasings a real
user would plausibly type. When accuracy plateaus near the ceiling, stop rather than
contorting frontmatter to squeeze the last case.

## Stopping

This loop does **not** run forever. Stop when: accuracy reaches 1.0, or it plateaus
for several iterations, or the only remaining gains would require overfitting. Report
the final accuracy, the kwChars delta, and the ledger.

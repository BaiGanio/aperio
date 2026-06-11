# Testing the autotune harness

The full, step-by-step testing guide now lives in the GitHub discussion so it
stays in one place:

**→ https://github.com/BaiGanio/aperio/discussions/130**

It covers the baseline smoke test, proving the metric is live, running one
tuning iteration by hand, the ledger, and the autonomous `/loop autotune`.

---

## Quick reference

No server needed — everything is the deterministic scorer (`score.mjs`) calling
the real matcher in `lib/workers/skills.js`. No LLM, no network. Run from the
repo root; `2>/dev/null` hides the one-line `📚 Skills indexed` log.

```bash
node skills/autotune/score.mjs 2>/dev/null            # score (train / holdout / kwChars + failures)
node skills/autotune/score.mjs --log keep --desc "…"  # score and append a ledger row
cat var/autotune/results.tsv                          # read the ledger
/loop autotune                                        # run the autonomous tuning loop
```

Baseline: `train 0.7308 [exam 18/18, hard 1/8]`, `holdout 0.5 [3/6]`, `kwChars 2646`.
`exam` must stay **18/18** — a drop means a tuning edit regressed another skill.

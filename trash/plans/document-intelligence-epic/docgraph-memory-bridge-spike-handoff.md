# Handoff: WS1 — Writable Destination (SQL Aggregation)

**Use this prompt in a fresh agent session to continue from the T-R5 pass.**

**WS0-R status: GREEN (2026-08-01).** T-R5 passed live on the local hero model
(Gemma 4 E4B) with the deterministic fact pipeline — see the new row below. All
rows before it measured free-form model arithmetic (the failure class the
pipeline removes). WS1 (writable destination) is now the next step.

---


### Updated cross-check verdict table

| Model | Categories | Grand total | EUR excluded | Leaks | Notes |
|-------|------------|-------------|--------------|-------|-------|
| deepseek-v4-flash | ✅ | ✅ | ❌ | EUR travel | 16s |
| deepseek-v4-pro | ✅ | ✅ | ✅ | none | ~30s |
| claude-sonnet-5 (claude-code) | ✅ | ✅ | ❌ | EUR travel tabled, not merged | 20.6s, after the preflight/claude-code structural fix above |
| claude-sonnet-5 (claude-code) rerun | ✅ | ✅ | ✅ | none | **full gate pass, 2026-07-27**, 20.5s — see below; behavior improved vs. the row above (Travel kept in its own unlabeled row, BGN subtotal line matches 696.84 exactly) |
| claude-opus-5 (claude-code) | ✅ | ❌ | ✅ (no raw leak) | none literal, but self-invented FX conversion | 23.8s, see below |
| Anthropic direct API (any model) | blocked | — | — | — | `ANTHROPIC_API_KEY` empty in `.env` and shell env |
| local (gemma-4-E2B) | partial | — | ❌ | EUR train fare | 8K ctx issue, 224.9s Metal run |
| local (gemma-4-E2B) rerun | 2/5 | ❌ | ✅ | none | **failed, 2026-07-27**, 230.3s; full retrieval, no timeout |
| local (gemma-4-26B-A4B) | 4/5 | ❌ | ✅ | none | **failed, 2026-07-27**, 472.5s; Fuel overcount and total 816.84 BGN |
| local (gemma-4-E4B) | 3/5 | ❌ | ✅ | none | **failed, 2026-07-27**, 278.1s; Fuel/Utilities errors and total 806.84 BGN |
| local (gemma-4-E4B) — deterministic pipeline | ✅ | ✅ | ✅ | none | **full gate pass, 2026-08-01**, 372.6s; answered from `doc_batch.aggregate` (facts pipeline, no model arithmetic); all totals exact, EUR 196.40 separate, clean teardown |
| local (Ornith-1.0-9B) | 2/5 | ❌ | ✅ | statement shortcut | **failed, 2026-07-27**, 292.5s; used statement total 260.75 BGN |
| local (gemma-4-12B) | 0/of 5 (timeout) | ❌ | — | none | 600s harness timeout after full retrieval |


---

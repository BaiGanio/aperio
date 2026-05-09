# Skills Deduplication Plan

After reviewing all 14 skills in `/skills/`, here is my analysis of what overlaps, what can be merged, and what can be removed.

---

## Critical Duplicate: `memory-learning` + `memory-protocol`

These two skills cover the same ground.

| Skill | Lines | Focus |
|-------|-------|-------|
| `memory-learning` | 263 | Full guide: SQL queries, schema, importance scoring, examples, edge cases |
| `memory-protocol` | 135 | Simplified tool reference: tool signatures, when to store, quality rules |

Both explain when to call `remember`, how to check for duplicates, what memory types exist, and what to store vs. skip. They just do it at different levels of detail.

**Recommendation:** Merge into one. Keep `memory-learning` as the canonical skill. Move any content from `memory-protocol` that isn't already covered (tool call signatures, the "what never to store" list). Delete `memory-protocol`.

---

## Partial Overlap: `coding-standards` + `working-with-files`

`coding-standards` has a full "Surgical File Editing" section with patch size tiers, inline patch format, and rewrite rules. `working-with-files` covers the exact same concept but for non-code files (Markdown, JSON, DOCX, PDF).

The ideas are nearly identical, just applied to different file types.

**Recommendation:** Do one of:
- **Merge:** Make `working-with-files` the single source of truth for all surgical editing. Have `coding-standards` reference it instead of duplicating the content.
- **Or keep separate** but strip the overlapping section from `coding-standards` — leave only a one-line pointer to `working-with-files`.

---

## Clear Boundary (Keep Separate): `reasoning-planning` + `prompt-optimizer`

These sound similar but have distinct jobs:

| Skill | Purpose |
|-------|---------|
| `reasoning-planning` | Structures the *agent's own thinking* before executing a task |
| `prompt-optimizer` | Structures the *user's vague idea* into a clear, actionable prompt |

They can chain together (optimize the idea → plan the execution) but do different things. Keep both.

---

## Clear Boundary (Keep Separate): `coding-standards` + `coding-examples`

`coding-standards` states the rules. `coding-examples` shows good/bad examples per language. They're designed as a pair and reference each other correctly. Keep both.

---

## Summary

| Action | Skills |
|--------|--------|
| **Merge** | `memory-protocol` → `memory-learning` |
| **Clean up overlap** | `coding-standards` surgical editing section |
| **Keep** | Everything else |

This reduces the active skill set from **14 → 10** with zero functional loss.

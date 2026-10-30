# Spec <step id> — <name>

Status: draft | **approved <date>** | changed <date> (why)
Plan step: `aperio-v2.md` → S<x.y> · Tests: `aperio-v2-tests.md` → T<x.y>
Size: 1–2 pages. If it is longer, split the step.

## 1. v1 study (read at `archive/v1-final`)

**How v1 did it** — files, main functions, data flow in 3–6 lines:
- `path/file.js` → `fn()` — what it does

**Best parts (keep):**
- …

**Bad parts (drop / fix):** name the AP id if one applies (AP1–AP9).
- …

**Lessons that apply:** Lessons Ledger ids + closed issues / tech-debt notes.
- L-xx — …

**v1 tests found:**
| Test file | What it covers | Reuse? (yes / partly / no + why) |
|---|---|---|

**v1 numbers (if measurable):** what was measured, how, the result. This is the bar.

## 2. Spec (the contract)

**Goal:** one sentence.

**Behaviour:**
1. …

**Interface:** functions / messages / tables, with input and output shapes.

**Errors:** each failure → what the user or caller sees. No silent failures (AP5).

**Limits:** sizes, token budget, timeouts, cache bounds (AP6). Every value comes from config (AP1).

**Non-goals:** what this step does NOT do (stops scope creep).

**Keeps from v1 / drops from v1:** one line each, with the reason.

## 3. Acceptance (becomes the tests)

- [ ] … (each item maps to one test case in T<x.y>)
- [ ] reused v1 test: `tests/...` — cut to scope
- [ ] new test: …

## 4. Open questions

- … (each one must be answered before approval)

---
name: code-simplification
description: >
  Use this skill when code already works but is harder to read or change than it
  should be — and the goal is to reduce that complexity without changing behavior.
  Triggers: "simplify this", "clean up", "this is overcomplicated", reducing
  nesting or duplication, removing dead code, or cutting an abstraction back to
  what's actually used. Behavior must stay identical and tests must stay green;
  this is refactoring for clarity, not a rewrite and not bug-fixing.
metadata:
  keywords: "simplify, simplification, simpler, clean up, cleanup, reduce complexity, overcomplicated, too complex, readability, dead code, untangle, technical debt, declutter, extract function, remove abstraction"
  category: "engineering-discipline"
  load: "on-demand"
---

# Code Simplification

## Purpose
Cut complexity that isn't earning its keep, while keeping behavior identical.
This matches the house rule *minimum code that solves the problem*: if 200 lines
could be 50, make it 50 — but never by changing what the code does.

## When to Use
- Code works but is hard to follow: deep nesting, long functions, duplication
- An abstraction added "for flexibility" that only has one caller
- Dead code, unused params, or speculative configuration to remove
- A diff review flagged something as more complex than it needs to be

## When NOT to Use
- The code is broken — fix it first ([[debugging-and-error-recovery]]); don't simplify around a bug
- A hot path where the "complex" version exists for measured performance
- Behavior needs to change — that's implementation, not simplification

---

## The Process

**1. Chesterton's Fence.** Before removing anything, understand why it's there.
If you can't explain what a branch, param, or abstraction is for, find out before
deleting it — apparent dead code is sometimes load-bearing.

**2. Pin behavior.** Make sure tests cover the current behavior. If they don't,
add one first (see [[test-driven-development]]) — it's your proof that
simplifying changed nothing.

**3. Simplify in small steps.** One transformation at a time, re-running tests
after each: flatten nesting with early returns, extract a well-named function,
inline a needless indirection, delete genuinely unused code, replace a clever
one-liner with a clear three.

**4. Prefer clarity over cleverness.** The goal is code a stranger reads once and
understands — not the shortest or most abstract version.

---

## Rationalizations — and the rebuttal

| You're telling yourself… | Reality |
|---|---|
| "I don't know what this does, I'll just delete it." | That's how you remove a load-bearing fence. Understand it first, or leave it. |
| "While I'm here I'll also change the behavior." | That's scope creep. Simplification keeps behavior identical — make behavior changes separately. |
| "I'll simplify, tests can wait." | Then you can't prove you didn't break anything. Pin behavior with a test first. |
| "Fewer lines is always better." | Not if it's denser and harder to read. Optimize for the next reader, not the line count. |

## Red Flags

- You're deleting code you can't explain the purpose of.
- Tests changed during a "simplification" — behavior moved, this isn't simplification anymore.
- The result is shorter but harder to understand.
- You're refactoring a measured hot path with no benchmark.

## Verification — evidence required

1. Tests pass *unchanged* before and after — behavior is identical.
2. Each removal is justified: state why the deleted code was safe to remove.
3. The result is genuinely clearer (less nesting/duplication), not just shorter.

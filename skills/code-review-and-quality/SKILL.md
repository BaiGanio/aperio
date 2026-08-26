---
name: code-review-and-quality
description: >
  Use this skill when reviewing a change before it merges — a pull request, a
  diff, or "check my code before I ship it." This is about the review PROCESS:
  what to look for, how to size a change, how to write useful review comments,
  and treating approval as a real gate. It is distinct from coding-standards,
  which defines the naming/style rules themselves; this skill is how a change
  gets reviewed against them and merged.
metadata:
  keywords: "code review, pull request, PR review, review my code, review the changes, diff review, diff, request changes, approve the change, merge gate, reviewer, review checklist, ready for review, blocking comment, blocking, change size"
  category: "engineering-discipline"
  load: "on-demand"
---

# Code Review & Quality

## Purpose
Make review a gate, not a rubber stamp. A good review checks that a change is
correct, minimal, and maintainable before it lands — and says so with specific,
actionable comments. Weak models tend to skim and approve; this skill gives a
fixed set of things to actually look at.

## When to Use
- Reviewing a pull request or a diff before merge
- The user asks to "check my code", "review this change", or "is this ready to ship"
- Self-review before opening a PR

## When NOT to Use
- Defining naming/style conventions from scratch → use [[coding-standards]]
- Reducing complexity of code you've decided to keep → use [[code-simplification]]
- Finding a bug's cause → use [[debugging-and-error-recovery]]

---

## What to Look For

Walk the diff against these, in order — design first, nits last:

1. **Design** — does the change belong here, and is the approach sound? A clean
   implementation of the wrong idea still gets sent back.
2. **Correctness** — does it do what it claims? Edge cases, error paths, off-by-ones.
3. **Tests** — is the new behavior covered, and would the tests actually fail if it broke?
4. **Complexity** — is anything more complicated than it needs to be? Flag it for [[code-simplification]].
5. **Naming & clarity** — names and comments per [[coding-standards]]; would a stranger follow this?
6. **Security** — any untrusted input, auth, or secrets touched? Defer to [[security-and-hardening]].

### Change size
Small changes get real reviews; giant ones get rubber-stamped. If a diff is too
large to review carefully, the correct review comment is "split this up."

### Writing review comments
- Be specific and actionable: point at the line, say what and why.
- Distinguish **blocking** (must fix) from **nit** (optional) — label them.
- Critique the code, not the author. Ask, don't command, when unsure.

---

## Rationalizations — and the rebuttal

| You're telling yourself… | Reality |
|---|---|
| "It looks fine, approve it." | "Looks fine" is not a review. Walk the six checks and point to what you verified. |
| "The diff is huge but I trust them." | Trust doesn't catch bugs. A diff too big to review is a diff to split, not to wave through. |
| "I'll just fix it myself silently." | Then the author never learns and the next PR has the same issue. Leave the comment. |
| "Style nits are the important part." | Design and correctness matter more. Don't bikeshed naming while missing a broken edge case. |

## Red Flags

- An approval with no comment on design, correctness, or tests.
- A change with new behavior and no new test.
- A diff so large you scrolled past most of it.
- Blocking and optional comments mixed together with no labels.

## Verification — evidence required

1. State, per the six checks, what you actually verified (not "looks good").
2. List blocking issues separately from nits.
3. Give an explicit verdict: approve, or request changes with concrete asks.

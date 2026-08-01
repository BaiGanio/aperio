---
name: code-minimalism
description: >
  Use this skill before writing new code — when the ask is to add a helper, a
  small feature, a utility, or a new module, and the right amount of code has not
  been decided yet. Triggers: "write me a helper for…", "add a small feature",
  "do I need a library for this", "keep it minimal", weighing a new dependency, or
  any request that could be met by something that already exists. Walk the ladder
  first: reuse beats stdlib beats platform beats dependency beats new code. This
  is the pre-write sibling of code-simplification, which cleans up afterwards.
metadata:
  keywords: "helper for, small helper, small utility, small feature, minimal code, minimum viable, keep it minimal, over engineer, over engineering, new dependency, another dependency, do i need a library, reinvent the wheel, yagni, scope creep"
  category: "engineering-discipline"
  load: "on-demand"
---

# Code Minimalism

## Purpose
Decide how much code should exist *before* writing any. The cheapest code to read,
test, review, and maintain is the code you never wrote — and the fastest tokens on
a local model are the ones never generated. This is the pre-write gate;
[[code-simplification]] is the post-write cleanup.

## When to Use
- A request to add a function, helper, utility, module, or "small feature"
- Weighing whether to pull in a new dependency
- The obvious implementation is starting to look like a framework
- Planning work with [[reasoning-planning]] — the ladder belongs in the plan, not
  in the review afterwards

## Delivery Boundary

A request to write, create, provide, or return code does not by itself authorize
saving or writing a file. Unless the user names a file or path, asks to save the
result, or asks to change code in an existing project, answer with the minimal code
inline. Use filesystem tools only when that persistence intent is explicit.

## When NOT to Use

**Never trim these.** Minimalism is about *how much gets built*, not about how
carefully it is built. It is not corner-cutting:

- **Validation** of anything crossing a trust boundary — see [[security-and-hardening]]
- **Error handling** on every path that can fail, including the unhappy ones
- **Security** checks: auth, path confinement, parameterized queries
- **Tests** for the behaviour you just added — see [[test-driven-development]]

Also skip the ladder when:

- The code is broken — that is debugging, not design ([[debugging-and-error-recovery]])
- The code already exists and works — that is [[code-simplification]]'s phase
- A measured requirement (performance, compliance, an explicit house convention)
  makes the larger implementation the correct one

---

## The Ladder

Walk it in order. Stop at the first rung that answers the request; every rung below
it is code you did not have to write.

**1. Does this need to exist at all?** Ask what breaks if it does not. Speculative
options, hooks "for later", and configuration nobody has asked for cost more than
they return. The right answer is sometimes "nothing — drop it", and saying so is
part of the job.

**2. Is it already in this codebase?** Search before writing: `grep`, the codegraph
tools, `lib/helpers/`. Aperio already owns path validation, config, embeddings,
rate limiting, logging. A second implementation is not neutral — it is a second
thing to keep in sync, and it will drift.

**3. Can the language or its stdlib do it?** Node's standard library covers far more
than it used to: `structuredClone`, `crypto.randomUUID`, `fs/promises`,
`AbortController`, `Intl`, `URL`, `node:test`. Reach here before any package.

**4. Can the native platform do it?** The platform already offers capabilities worth
using before you build them: SQLite FTS5 and `sqlite-vec` for search, Postgres
`pgvector`, Express middleware, the DOM and CSS for UI behaviour. Databases and
browsers are better at their own jobs than a hand-rolled layer will be.

**5. Can an already-installed dependency do it?** Read `package.json` before adding
anything. A new runtime dependency is a permanent cost: install size, supply-chain
surface, upgrade work, and one more thing to explain. Adding one is a decision to
raise explicitly, not a detail to slip into a diff.

**6. Can it be a few inline lines?** A four-line function at its only call site
beats a new module with its own file, export, and test harness. Wait for the second
caller before extracting.

**7. Only then: write the minimum viable code** that satisfies the requirement, its
error paths, and its tests — and nothing beyond it.

### Lazy about the solution, never about reading

The ladder shortens what you *write*. It never shortens what you *read* first. You
cannot honestly answer rung 2 without searching the codebase, or rung 5 without
reading `package.json`. Skipping the reading to reach "write it yourself" faster
inverts the whole point.

---

## Rationalizations — and the rebuttal

| You're telling yourself… | Reality |
|---|---|
| "I'll make it configurable, just in case." | Nobody asked. Configuration you cannot name a caller for is dead weight with a maintenance bill. |
| "Searching for an existing one takes longer than writing it." | Writing it takes five minutes; keeping two copies in sync takes years. Search first. |
| "It's only one small dependency." | It is also a lockfile entry, an upgrade path, and an attack surface. Justify it out loud or do without. |
| "A proper abstraction now saves time later." | Only if "later" arrives. Wait for the second caller — the right abstraction is obvious then and guesswork now. |
| "Minimal means I can skip the validation." | No. Validation, error handling, security, and tests are never the thing that gets cut. |
| "The base class will make subclassing easy." | You have one case. A class hierarchy for one case is a framework with a user count of one. |

## Red Flags

- A new file whose only export has exactly one caller, added in the same diff.
- A parameter, flag, or hook with no caller passing it.
- `package.json` gained a dependency for something the stdlib already does.
- The implementation is a general solution to a problem stated in the singular.
- You wrote a wrapper around an Aperio helper instead of calling it.
- The diff is larger than the description of what it does.

## Verification — evidence required

1. Name the rung you stopped at, and why the ones above it did not apply.
2. For rung 2: state what you searched for and what you found (or did not).
3. For a new dependency: say what it replaces and why the stdlib could not.
4. Confirm the non-negotiables survived: validation, error handling, security
   checks, and tests are present — the diff is small because less was built, not
   because less was checked.

---

*The ladder is adapted from [ponytail](https://github.com/DietrichGebert/ponytail)
(MIT) — a portable instruction set that teaches coding agents to write only the code
that has to exist. Aperio's rung 2 is anamnesis applied to code: recall what the
codebase already knows before writing it again.*

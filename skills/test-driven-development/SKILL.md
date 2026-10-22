---
name: test-driven-development
description: >
  Use this skill when writing or changing code whose correctness matters and you
  want proof it works — not a claim that it works. Triggers: implementing a
  function or feature where you can write a test first, adding a regression test
  for a bug, or any time you are tempted to say "it works" without evidence. The
  core move is RED → GREEN → REFACTOR: write a failing test, make it pass, then
  clean up. This is the methodology; webapp-testing and run_tests are the tools.
metadata:
  keywords: "tdd, test driven, write a test, test first, failing test, red green refactor, unit test, test coverage, regression test, assertion, test suite, prove it with a test"
  category: "engineering-discipline"
  load: "on-demand"
---

# Test-Driven Development

## Purpose
Make correctness provable. Weak models declare success on code they never ran.
TDD forces the opposite order: the test exists and fails *before* the code, so
"green" is evidence rather than a guess.

## When to Use
- Implementing a function, module, or feature with definable correct behavior
- Fixing a bug — write a test that reproduces it first (the Prove-It pattern)
- Changing existing behavior — pin current behavior with a test, then change it

## When NOT to Use
- Throwaway scripts, spikes, or exploration you will delete
- Pure styling / layout with no logic to assert (use webapp-testing visually)
- Behavior that genuinely cannot be expressed as an assertion

---

## The Cycle

**RED.** Write one small test for the next bit of behavior. Run it. Watch it
**fail** — and confirm it fails for the *right reason* (the assertion, not an
import error). A test you never saw fail proves nothing.

**GREEN.** Write the minimum code to make that test pass. No extra features, no
speculative branches. Run the test. See it pass.

**REFACTOR.** With the test green, clean up names and duplication. Re-run — still
green. Only now move to the next test.

### Prove-It pattern (for bugs)
Before fixing a bug, write a test that fails *because of the bug*. Now the fix
has a definition of done: that test going green. Pairs with
[[debugging-and-error-recovery]] — debug to find the cause, TDD to lock it shut.

### Test pyramid
Prefer many fast **unit** tests, fewer **integration** tests, very few **e2e**.
If a test needs the whole app to run, ask whether a unit test would catch the
same thing faster.

---

## Rationalizations — and the rebuttal

| You're telling yourself… | Reality |
|---|---|
| "I'll write the tests after." | You won't, and if you do they'll be shaped to pass the code rather than to catch bugs. Test first. |
| "This is too simple to test." | Then the test is trivial to write. Simple code still breaks under later edits. |
| "The test passed on the first run." | A test that never failed may be asserting nothing. Make it fail once on purpose to prove it bites. |
| "Manual testing is faster." | Once. The test pays back every time you touch this code again. |

## Red Flags

- You wrote 100 lines of implementation before any test.
- Your test passed the very first time you ran it — you never saw RED.
- A test asserts nothing meaningful (`expect(true).toBe(true)`, no assertions).
- You changed the test to match buggy output instead of fixing the code.

## Verification — evidence required

1. Show the test failing first (RED), then passing (GREEN) — both outputs.
2. The assertion names the actual expected behavior, not a tautology.
3. For a bug fix: the new regression test fails on the old code and passes on the new.

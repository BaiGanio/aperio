---
name: debugging-and-error-recovery
description: >
  Use this skill when something is broken and the cause is unknown — a crash, an
  exception, a failing test, a wrong result, or "it worked yesterday." Triggers:
  debugging a bug, reading a stack trace, an unhandled exception, code that is not
  working or producing wrong output, or an agent that has tried the same fix twice
  and is looping. This skill is about FINDING the cause systematically, not about
  writing new features.
metadata:
  keywords: "debug, debugging, bug, fix the bug, stack trace, traceback, exception, crash, broken, not working, wrong output, root cause, reproduce, isolate, hypothesis, why is this failing, error message"
  category: "engineering-discipline"
  load: "on-demand"
---

# Debugging & Error Recovery

## Purpose
A loop for finding the cause of a failure instead of guessing at fixes. Weak
models fail here by changing code at random, re-running, and hoping — burning
turns while the real cause stays hidden. This skill replaces guessing with a
disciplined Reproduce → Isolate → Hypothesize → Fix → Verify cycle, and gives an
explicit signal for when to stop and step back.

## When to Use
- A test, build, or command fails and you don't yet know why
- A stack trace, exception, or error message appeared
- Code produces wrong output, or "worked before and doesn't now"
- You have already tried one fix and it didn't work

## When NOT to Use
- You know the exact cause and the fix is obvious — just make it
- The "bug" is a missing feature — that's implementation, not debugging
- The failure is environmental and already understood (e.g. missing API key)

---

## The Loop

Run these in order. Do not skip to **Fix**.

**1. Reproduce.** Get the failure to happen on demand. Capture the exact command,
input, and full error text. If you cannot reproduce it, you cannot fix it —
gather more information first (logs, the user's exact steps).

**2. Isolate.** Narrow to the smallest unit that still fails. Bisect: comment out
half, re-run, repeat. Read the actual stack trace top frame — it names the file
and line. Do not theorize about distant code before reading what the trace says.

**3. Hypothesize.** State one specific, testable theory of the root cause in a
sentence: "X is null because Y returns undefined when Z." If you cannot name a
cause, you are still in step 2.

**4. Fix.** Make the smallest change that addresses the *cause* you named — not
the symptom. One change at a time.

**5. Verify.** Re-run the reproduction from step 1. Confirm it now passes, then
run the surrounding tests to check you broke nothing else.

---

## Rationalizations — and the rebuttal

| You're telling yourself… | Reality |
|---|---|
| "Let me just try changing this and see." | That's guessing. Reproduce and isolate first — random changes hide the real cause and create new bugs. |
| "The error is probably in the obvious place." | Read the stack trace before assuming. The top frame is data; your hunch is not. |
| "I'll add a try/catch to make the error go away." | Swallowing an error is not fixing it. Name the cause first; catch only if the cause is genuinely recoverable. |
| "It's flaky, let me just re-run it." | Intermittent failures have causes too (ordering, timing, shared state). Reproduce the flake, don't paper over it. |

## Red Flags — stop and step back

- You have applied the **same or a similar fix twice** and it still fails. Stop. Your hypothesis is wrong — return to step 2 and isolate again.
- You are **3+ edits deep** with no reproduction and no named cause. You are guessing. Go back to step 1.
- You are editing files the stack trace never mentioned. Justify why, or stop.
- You are about to say "it should work now" without having re-run the reproduction.

## Verification — evidence required before declaring it fixed

Do not claim the bug is fixed on reasoning alone. Show:
1. The reproduction command, now passing (paste the output).
2. The surrounding test suite still green.
3. One sentence naming the root cause that was fixed.

If you cannot produce all three, the bug is not fixed — say so plainly.

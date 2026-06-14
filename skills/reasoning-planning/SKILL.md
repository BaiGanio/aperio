---
name: reasoning-planning
description: >
  Use this skill when a task is complex, multi-step, or ambiguous and the agent
  needs to think before acting — not just format output. Triggers: problems with
  unclear requirements, tasks with dependencies or sequencing, situations where
  acting immediately risks doing the wrong thing, or any task where "plan first,
  execute second" is safer than jumping in.
metadata:
  keywords: "breakdown, decomposition, strategy, logic, steps, planning, dependencies, edge cases, validation"
  category: "cognitive-process"
  load: "on-demand"
---

# Reasoning & Planning Skill

## Purpose
A cognitive scaffolding skill. It forces structured thinking *before* execution —
not as a deliverable to show the user, but as an internal reasoning layer that
produces a validated plan the agent then acts on.

This is distinct from prompt-optimizer, which structures user *ideas*.
This skill structures the agent's own *thinking process* before taking action.

## When to Use
- The task has 3+ steps with dependencies between them
- Requirements are ambiguous or contradictory
- A wrong first action would be costly or hard to reverse
- Multiple valid approaches exist and the tradeoffs aren't obvious
- Edge cases could silently break the output

## When NOT to Use
- Simple, single-step tasks (just do them)
- The user explicitly asked for output formatting or prompt structuring (use prompt-optimizer)
- Creative tasks with no right/wrong answer

---

## Reasoning Process

Work through these stages internally. Surface the output of each stage clearly.

### 1. Restate the Problem
- What is *actually* being asked? (Strip the phrasing, find the intent)
- What are the hard constraints? (Non-negotiable limits)
- What is unknown or ambiguous? (Flag explicitly — don't silently assume)

### 1b. For a feature or build task: write a quick spec first
When the task is "build / add / implement X" (not pure analysis), spend a few
lines pinning down *what done means* before planning *how*. Surface assumptions
out loud so a wrong one gets caught now, not after the code is written:

```
ASSUMPTIONS I'M MAKING: [the things you're taking as given — the riskiest first]
```

Then cover, briefly, only the areas that apply:
- **Objective** — the one outcome that makes this done
- **Interface** — the commands / API / function signatures it exposes
- **Structure** — where the code lives, what it touches
- **Style & constraints** — conventions to follow, things it must not break
- **Testing** — how correctness will be proven (pairs with [[test-driven-development]])
- **Boundaries** — explicitly out of scope

Reframe vague asks into testable criteria: "make it faster" → "p95 < 200ms";
"add validation" → "rejects empty/oversized input with a 400". A spec is only
useful if its success conditions can be checked.

### 2. Identify Dependencies
Before listing steps, ask: *what must be true before each step can run?*
- Map inputs → outputs for each sub-task
- Flag any step that depends on the result of a previous uncertain step
- If a dependency is circular, stop and surface it to the user

### 3. Choose an Approach
Consider 2 approaches maximum. For each:
- State the core assumption it relies on
- State what breaks it

Pick the more robust one. If both are equally risky, say so and ask.

### 4. Write the Execution Plan
| Step | Action | Depends On | Fail Condition |
|------|--------|------------|----------------|
| 1 | ... | nothing | ... |
| 2 | ... | Step 1 result | ... |

Each step needs a clear success signal and a defined fallback.

### 5. Validate Before Acting
Check explicitly:
- [ ] No circular dependencies
- [ ] Edge cases covered (empty input, missing data, conflicting values)
- [ ] Each step is independently testable
- [ ] Plan survives if step 2 fails — what happens next?

If validation fails, revise the plan before proceeding.

---

## Output Format

Show reasoning *concisely*. This is not a report — it's a thinking log.

```
Problem: [one sentence restatement]
Unknowns: [list only genuinely missing info]
Approach: [chosen method + one-line rationale]
Plan:
  1. [action] → [success signal]
  2. [action] → [success signal]
  ...
Edge cases: [what could silently fail and how it's handled]
```

Then act on the plan immediately after. Don't ask for approval unless a critical
unknown blocks execution.

---

## Executing the Plan — incrementally and verified

A validated plan is executed one slice at a time, not in one big dump. For each
step:

1. **Do one slice** — the smallest change that completes a single plan step.
2. **Verify it** — run the relevant test, build, or lint before moving on. Don't
   stack a second change on an unverified first.
3. **Checkpoint** — commit or note the working state, so the work can be paused
   and resumed cleanly.
4. **On failure, stop** — if a step fails or turns out riskier than planned,
   pause and reassess rather than bulldozing ahead. A failing step is a signal,
   not an obstacle to power through. (Diagnose with
   [[debugging-and-error-recovery]].)

The discipline: never report a step done without the evidence that it works, and
never let one broken step compound into three.

---

## Example

**Input:** "Analyze customer feedback from emails, surveys, and chat logs and find the main themes."

```
Problem: Aggregate and thematically cluster feedback from 3 heterogeneous sources.
Unknowns: Volume of data, whether sources share a common ID/customer field.
Approach: Automated clustering (TF-IDF or embedding-based) — faster and consistent
  at scale; manual review used only to validate sample output.
Plan:
  1. Collect + normalize all three sources into a unified schema → single dataset with source tag
  2. Clean: remove duplicates, strip PII, normalize encoding → clean corpus
  3. Extract themes via clustering → labeled theme list with frequency counts
  4. Validate: manually review 10 samples per theme → confirm or relabel
Edge cases:
  - Missing data in one source: proceed with available data, flag gap in output
  - Overlapping themes: merge if cosine similarity > 0.85, flag for human review
```

---

## Relationship to Other Skills
| Skill | Focus |
|-------|-------|
| prompt-optimizer | Structures a user's *idea* into an actionable schema |
| reasoning-planning | Structures the *agent's thinking* before executing a task |

These can chain: prompt-optimizer clarifies what to build → reasoning-planning figures out how to build it.
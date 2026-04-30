---
name: prompt-optimizer
description: >
  Use this skill when a user provides a vague, rough, or underdeveloped idea
  and wants it turned into a clear, structured, actionable prompt or plan.
  Triggers: "help me structure this", "I have an idea but don't know where to start",
  "make this into a proper prompt", or any half-formed concept needing decomposition.
---

# Prompt Optimizer Skill

## Purpose
Transforms raw, vague, or disorganized user ideas into structured, actionable plans
using clean markdown — not JSON. The output is meant to be read by humans and acted
on immediately.

## When to Use
- User provides a rough concept and needs it decomposed into clear steps.
- A task needs measurable inputs, outputs, and reasoning laid out plainly.
- User asks to "turn this into a proper prompt" or "help me structure this idea."

## When NOT to Use
- The input is already well-structured — refine, don't over-engineer.
- The request is for code generation, document creation, or research (use other skills).

## Output Format

Respond in clean markdown with these four sections:

### 🎯 Goal
One crisp sentence stating the core objective. Strip all vagueness.

### 📥 Inputs Needed
A short table:

| Input | Why It Matters |
|-------|----------------|
| ... | ... |

Only list inputs that *genuinely change the output*. Omit obvious or derivable ones.

### 📤 Output Format
Bullet list of concrete deliverables. Each item should be specific enough that
the user knows exactly what they'll get.

### 🧠 Chain-of-Thought
3–5 plain-English statements explaining the reasoning. Each statement must:
- Start with the *constraint or decision* being addressed
- End with *why* that choice was made
- Be one sentence, no filler

## Reasoning Priorities (for Chain-of-Thought)
Always reason in this order:
1. **Core constraint first** — what is the single biggest limiting factor?
2. **Audience/context** — who is this for, and what do they already know?
3. **Scope boundary** — what is explicitly out of scope to prevent bloat?
4. **Success signal** — how will the user know the output worked?

## Edge Cases
- **Input too vague to infer anything**: Ask one clarifying question before proceeding.
- **Input already well-structured**: State that briefly, then suggest only refinements.
- **Multiple goals detected**: Pick the primary one, note the others under Goal.

## Formatting Rules
- Use markdown headers, tables, and bullets — never JSON.
- Keep the entire response scannable in under 30 seconds.
- No preamble, no sign-off, no meta-commentary outside the four sections.
- Tone: clear, direct, helpful coworker — not a consultant writing a report.

## Example

**Raw input:** "I want to make a web app for tracking my gym progress."

---

### 🎯 Goal
Build and launch a workout tracking web app with user accounts and progress visualization.

### 📥 Inputs Needed

| Input | Why It Matters |
|-------|----------------|
| Preferred tech stack | Determines architecture before any code is written |
| Key features (weights, cardio, body metrics?) | Defines the data model and MVP scope |
| Target platform (mobile, desktop, both?) | Affects framework and UI decisions |
| Authentication method | Foundational — hard to change later |

### 📤 Output Format
- MVP feature list ranked by priority
- Recommended database schema (table/collection names + key fields)
- Tech stack recommendation with brief rationale
- 4-week development roadmap with weekly milestones

### 🧠 Chain-of-Thought
Tech stack must be decided first — it constrains every subsequent architectural choice.
Authentication is a foundational pillar, not a feature — design for it from day one.
The data model depends on feature scope — log complexity (sets/reps vs. cardio intervals) determines relational vs. document storage.
MVP scope should be defined before the roadmap — prevents the roadmap from expanding to fill available time.
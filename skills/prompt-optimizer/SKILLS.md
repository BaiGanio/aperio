---
name: prompt-optimizer
description: Neutral, professional prompt optimizer.
---

# Prompt Optimizer Skill

## Purpose
Transforms raw, messy, or vague user ideas into highly structured, actionable JSON schemas paired with a logical reasoning layer (Chain-of-thought).

## When to Use
- When a user provides a "half-baked" or unorganized concept.
- When a task needs to be decomposed into measurable inputs and outputs.
- When you need to create standardized templates for task execution.

## Instructions

1. **Analyze & Infer**: Deconstruct the raw input to identify the core goal. Determine the minimum necessary `inputs_needed` and the desired `output_format`. Keep the JSON schema minimal.
2. **Structure the JSON**: Output a clean JSON object containing the inferred fields.
3. **Apply Reasoning (Chain-of-thought)**: Immediately below the JSON, provide a plain-English "Chain-of-thought:" section. 
   - Detail the step-by-step logic used to arrive at the schema.
   - Explain *why* certain constraints or inputs were prioritized.
4. **Formatting**: 
   - The entire response (JSON + Chain-of-thought) **must** be wrapped in a single, continuous code block.
   - Use a professional, "helpful coworker" tone: clear, friendly, and devoid of hype.
5. **Constraint**: Do not add any text, commentary, or markdown outside of that single code block.

## Examples

#### Example 1
**Raw input**: "I want to learn how to play guitar but I'm a complete beginner and I don't have a lot of time."

{
  "goal": "create a beginner guitar learning plan",
  "inputs_needed": ["available practice time per week", "music style preference", "access to instrument", "budget for lessons or apps"],
  "output_format": ["weekly practice schedule", "skill milestones", "recommended resources", "first songs to learn"]
}

**Chain-of-thought:**
Establish available time before building any schedule — time is the real constraint here, not skill.
Match music style preference to the learning path early — classical and rock require different foundational techniques.
Recommend free resources first unless budget is confirmed.
First songs should be achievable within two weeks — early wins matter more than technical difficulty at this stage.

---

#### Example 2
**Raw input:** "I'm thinking about starting a podcast. What should I do first?"

{
  "goal": "create a podcast launch plan",
  "inputs_needed": ["topic or niche", "target audience", "publishing frequency", "budget for equipment"],
  "output_format": ["show format recommendation", "episode structure", "equipment list by budget tier", "launch timeline", "first five episode ideas"]
}

**Chain-of-thought:**
Start with audience clarity before any format decisions — who this is for determines everything else.
Match equipment recommendation to stated budget — no over-engineering for a first show.
First five episode ideas should validate the niche before committing to production.
Launch timeline assumes zero existing audience — build for discoverability first, growth second.

---

#### Example 3
**Raw input:** "I want to make a web app for tracking my gym progress and seeing my stats. I'm not sure about the tech stack yet, but I want it to be modern and handle user logins."

{
  "goal": "create a technical implementation plan for a workout tracking web app",
  "inputs_needed": ["preferred tech stack", "target platforms", "key features (e.g., weights, reps, cardio)", "authentication requirements", "data persistence needs"],
  "output_format": ["feature requirements document", "database schema design", "recommended API architecture", "initial development roadmap", "MVP scope definition"]
}

**Chain-of-thought:**
Identify the tech stack first — the choice of framework (e.g., React vs. Next.js) dictates the entire frontend architecture.
Determine the complexity of data tracking — deciding between relational (Postgres) or document (MongoDB) depends on how deeply nested/relational the workout logs are.
Define the MVP (Minimum Viable Product) features early — prevent scope creep by focusing on the core loop of 'log activity' -> 'view history'.
Include authentication requirements in the architecture plan — security and user session management are foundational architectural pillars.
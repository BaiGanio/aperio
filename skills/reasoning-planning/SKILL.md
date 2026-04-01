---
name: reasoning-planning
description: Break down complex problems into steps, create execution plans, handle uncertainty
---

# Reasoning & Planning Skill

## Purpose
Enables the agent to think through problems step-by-step before acting, handle edge cases, and create adaptable plans.

## When to Use
- Complex multi-step problems
- Uncertain situations requiring alternatives
- Tasks needing validation before execution
- Problems with multiple possible solutions

## Instructions

When activated, follow this pattern:

1. **Problem Analysis** - Restate the problem clearly
   - What is being asked?
   - What constraints exist?
   - What information is missing?

2. **Break Into Steps** - Decompose into smaller tasks
   - List 3-5 logical steps
   - Identify dependencies between steps
   - Flag uncertain steps

3. **Consider Alternatives** - Think of 2+ approaches
   - What's the primary approach?
   - What's a backup approach?
   - Which is most robust?

4. **Create Execution Plan** - Write the actual plan
   - Step-by-step instructions
   - Success criteria for each step
   - Fallback actions if step fails

5. **Validate** - Check the plan
   - Does it cover edge cases?
   - Are there circular dependencies?
   - Is it testable?

## Example

**Problem**: "I need to analyze customer feedback from 3 sources"

**Your Response**:
- Problem: Aggregate feedback from emails, surveys, and chat logs; identify themes
- Steps: (1) Collect data, (2) Clean/normalize, (3) Extract themes, (4) Rank by frequency
- Alternatives: Manual review vs. automated clustering
- Plan: Use clustering algorithm, validate with sample manual review
- Validation: ✓ Covers all sources, ✓ Handles missing data, ✓ Testable with 10 samples

## Test Prompt
"Use reasoning-planning to break down: How would you build a chatbot that learns from user corrections?"

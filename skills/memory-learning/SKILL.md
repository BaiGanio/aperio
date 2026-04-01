---
name: memory-learning
description: Maintain context across interactions, learn from feedback, improve over time
---

# Memory & Learning Skill

## Purpose
Enables the agent to remember past interactions, learn from corrections, and adapt behavior based on experience.

## When to Use
- Multi-turn conversations
- Learning from user feedback
- Improving performance on repeated tasks
- Personalizing responses

## Instructions

1. **Store Context** - Remember what matters
   - What information is relevant for future interactions?
   - What decisions were made and why?
   - What did the user prefer?
   - Store in: conversation history, user profile, decision log

2. **Retrieve Relevant Memory** - Access what you need
   - What past interactions are relevant to this task?
   - What preferences has the user expressed?
   - What mistakes should I avoid?
   - Search memory by: topic, user ID, time period, decision type

3. **Learn from Feedback** - Update your knowledge
   - User said: "That's wrong, try X instead"
   - Update rule: Next time, use X for this scenario
   - User said: "Perfect, do that again"
   - Reinforce: This approach works for this context

4. **Adapt Behavior** - Apply lessons
   - Check memory before acting
   - Use learned patterns
   - Personalize based on user history
   - Avoid repeated mistakes

5. **Evaluate Learning** - Track improvement
   - Did feedback improve performance?
   - How often is learned knowledge used?
   - What patterns are emerging?

## Example Memory Flow

**Interaction 1**:
- User: "Format my dates as DD/MM/YYYY"
- Agent stores: {user_id: 123, preference: "date_format=DD/MM/YYYY"}

**Interaction 2**:
- Agent retrieves: user_id 123 prefers DD/MM/YYYY
- Agent formats date as: 15/04/2026
- User: "Perfect!"
- Agent reinforces: Preference confirmed

**Interaction 3**:
- Agent proactively uses DD/MM/YYYY format (learned behavior)
- User doesn't need to repeat preference

## Test Prompt
"Use memory-learning to design: An agent that remembers a user's coding style, learns from corrections, and applies those lessons to future code suggestions"

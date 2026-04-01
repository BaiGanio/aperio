---
name: tool-integration
description: Effectively call APIs, chain operations, select appropriate tools
---

# Tool Use & Integration Skill

## Purpose
Enables the agent to know which tools to use, how to chain them, and handle tool failures gracefully.

## When to Use
- Calling external APIs or services
- Chaining multiple operations together
- Selecting the right tool for a subtask
- Handling tool errors and retries

## Instructions

1. **Tool Inventory** - Know what tools are available
   - List available tools
   - Understand each tool's purpose
   - Note input/output requirements

2. **Tool Selection** - Pick the right tool
   - What problem are you solving?
   - Which tool matches best?
   - Are there alternative tools?

3. **Build the Chain** - Connect operations
   - What's the input to tool A?
   - What's the output from tool A that feeds tool B?
   - What happens if a tool fails?

4. **Execute & Monitor** - Run and watch
   - Call tool with correct parameters
   - Check response status
   - Log results for debugging

5. **Error Handling** - Gracefully recover
   - Identify error type (timeout, auth, invalid input)
   - Retry with backoff if transient
   - Use fallback tool if available
   - Report clear error to user

## Example Tool Chain

**Goal**: Get weather → Format message → Send via email


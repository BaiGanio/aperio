---
name: tool-integration
description: >
  Use this skill when the agent needs to call one or more external tools, APIs,
  or services to complete a task. Triggers: any task requiring data from an
  external source, chaining multiple tool calls where one output feeds the next,
  handling tool failures or retries, or selecting between multiple available tools
  for the same subtask.
metadata:
  keywords: "api, tool call, chain, integration, retry, fallback, error handling, external service"
  category: "execution"
  load: "on-demand"
---

# Tool Use & Integration Skill

## Purpose
Gives the agent a consistent, reliable pattern for selecting, calling, chaining,
and recovering from external tools and APIs — before touching any tool.

This is an *execution* skill, not a planning skill. Use reasoning-planning first
if the overall task is complex; use this skill when it's time to actually call something.

## When to Use
- Calling any external API, service, or data source
- Chaining operations where tool A's output is tool B's input
- Choosing between multiple tools that could serve the same purpose
- Any situation where a tool call might fail and recovery matters

## When NOT to Use
- No external tools are involved (pure reasoning or text generation)
- The task is structuring a plan rather than executing one (use reasoning-planning)

---

## Process

### 1. Tool Inventory
Before calling anything, establish what's available:

| Tool | Purpose | Input | Output | Failure Mode |
|------|---------|-------|--------|--------------|
| ... | ... | ... | ... | ... |

Only list tools relevant to the current task. If a needed tool is unavailable, say so immediately — don't improvise a workaround silently.

### 2. Tool Selection
For each subtask, answer:
- Which tool's output format matches what this step needs?
- If two tools could work, which has the lower failure risk?
- Is there a read-only tool that can validate before a write tool commits?

**Rule:** Prefer the tool that does less. Narrow scope = fewer failure surfaces.

### 3. Chain Design
Map the full chain before executing any step:

```
[Input] → Tool A (param: x) → [Output A]
                                    ↓
               Tool B (param: Output A.field) → [Output B]
                                                     ↓
                              Tool C (param: Output B) → [Final Output]
```

For each arrow, define explicitly:
- Which field from the previous output is used
- What type/format is expected
- What value triggers an abort (null, empty array, error code, etc.)

Never start executing a chain you haven't fully mapped.

### 4. Execute & Validate
Call each tool in sequence:
- Pass only the parameters that tool explicitly requires — no extras
- After each call, validate the response before passing it forward:
  - Status/code check (200, success flag, non-null)
  - Shape check (expected fields present)
  - Value sanity check (non-empty, within expected range)
- If validation fails at any step, **stop the chain** and go to error handling

### 5. Error Handling

Classify the error before deciding what to do:

| Error Type | Examples | Action |
|------------|----------|--------|
| Transient | Timeout, 429, 503 | Retry up to 3x with exponential backoff (1s → 2s → 4s) |
| Auth | 401, 403 | Stop immediately. Report to user — no retry |
| Bad input | 400, validation error | Fix parameters if possible, retry once. If unclear, ask user |
| Fatal | 500, tool unavailable | Try fallback tool if one exists; otherwise stop and report |

**Fallback rule:** Only use a fallback tool if its output schema is compatible with what the next step expects. Don't force a fallback that changes the chain's data shape.

**Report rule:** Always surface errors with: what failed, why (error type + code), what was attempted, and what the user needs to do next (if anything).

---

## Output Format

After execution, report concisely:

```
Chain executed: Tool A → Tool B → Tool C
Status: [success / partial / failed]
Result: [final output or what was produced before failure]
Errors: [any errors encountered + how they were handled]
Next: [what happens now, or what the user needs to do]
```

---

## Example

**Goal:** Fetch weather for a city → format it → send via email

```
Chain map:
  [city: "Sofia"] → weather_api(city) → { temp: 18, condition: "cloudy" }
                                               ↓
                    format_message(temp, condition) → "It's 18°C and cloudy in Sofia."
                                                              ↓
                              email_send(to: user@x.com, body: above) → { status: "sent" }

Validation checkpoints:
  - After weather_api: temp must be a number, condition must be non-null
  - After format_message: output must be a non-empty string
  - After email_send: status must equal "sent"

Error handling:
  - weather_api timeout → retry 3x with backoff
  - email_send 401 → stop, report auth failure to user
  - format_message returns empty → abort chain, log input values

Chain executed: weather_api → format_message → email_send
Status: success
Result: Email delivered to user@x.com
Errors: none
Next: nothing required
```

---

## Relationship to Other Skills
| Skill | Role |
|-------|------|
| reasoning-planning | Plan *what* to do and in what order |
| tool-integration | Execute the plan by calling actual tools |
| prompt-optimizer | Structure the user's goal before planning or execution begins |

Typical chain: **prompt-optimizer** → **reasoning-planning** → **tool-integration**
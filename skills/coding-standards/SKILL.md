---
name: coding-standards
description: Naming conventions, code style rules, and quality examples for all code written by the agent.
metadata:
  keywords: "naming, conventions, camelCase, PascalCase, style, code quality, error handling, typescript, javascript"
  category: "code-quality"
---

# Coding Standards Skill

## Purpose
Defines the rules the agent must follow when writing, reviewing, or modifying any code — regardless of language or context.

## When to Use
- Writing new functions, classes, or modules
- Reviewing or refactoring existing code
- Responding to any coding task or question

## Naming Conventions

| Construct  | Style            | Examples                          |
|------------|------------------|-----------------------------------|
| Functions  | camelCase        | `getUserData`, `calculateTotal`   |
| Classes    | PascalCase       | `UserService`, `DataController`   |
| Constants  | UPPER_SNAKE_CASE | `API_KEY`, `MAX_RETRIES`          |
| Variables  | camelCase        | `userId`, `isReady`               |
| Files      | kebab-case       | `user-service.ts`, `db-index.js`  |

## Code Style Rules

1. **Descriptive names** — names should read like plain English. Avoid `x`, `tmp`, `data`, `res` unless scope is tiny.
2. **Always handle errors** — async functions must have try/catch or propagate errors explicitly.
3. **Comments explain WHY, not WHAT** — the code shows what; comments show intent or non-obvious reasoning.
4. **One responsibility per function** — if a function does two things, split it.
5. **No magic numbers** — extract literals into named constants.

## Examples

```typescript
// ✅ Good — descriptive name, guard clause, proper error handling
async function fetchUserById(id: string): Promise<User> {
  if (!id) throw new Error('User ID required');

  const response = await api.get(`/users/${id}`);
  return response.data;
}

// ✅ Good — named constant, clear intent
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

// ❌ Bad — vague name, no error handling, magic number
async function get(x) {
  return await api.get('/users/' + x).data;
}

// ❌ Bad — comment states the obvious, not the why
// Loop through users
for (const user of users) { ... }

// ✅ Good — comment explains the why
// Skip inactive users — billing only applies to active accounts
for (const user of users.filter(u => u.active)) { ... }
```

## Test Prompt
"Use coding-standards to review this function: `async function d(x) { return db.find(x) }`"
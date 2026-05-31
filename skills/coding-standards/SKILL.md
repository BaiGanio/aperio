---
name: coding-standards
description: >
  Use this skill whenever writing, reviewing, or modifying any code in any
  programming language. Enforces universal principles first, then applies
  language-specific naming conventions. Detect language from context (file
  extension, user statement, existing code). If ambiguous, ask before writing
  significant code. For annotated good/bad examples per language, also match
  coding-standards-examples.
metadata:
  keywords: "naming, conventions, style, code quality, error handling, typescript, javascript, python, go, rust, java, csharp, multi-language, coding, writing code, code review"
  category: "code-quality"
  load: "on-demand"
---

# Coding Standards — Core

## Layer 1 — Universal Principles (all languages, always)

### Naming
- Names must read like plain English. Avoid `x`, `tmp`, `data`, `res`, `obj` unless scope is 2–3 lines.
- Booleans: prefix with `is`, `has`, `can`, `should`.
- Event handlers: prefix with `handle` or `on`.
- If you can't name it clearly, the function is probably doing too much.

### Functions
- One responsibility per function. If it does two things, split it.
- Guard clauses first — validate inputs at the top, return or throw early.
- No silent failures — errors must be caught, propagated, or explicitly ignored with a comment.
- Aim for ~30 lines max.

### Constants & Values
- No magic numbers or magic strings — extract into named constants.
- Group related constants together.

### Comments
- Explain WHY, not WHAT. The code shows what; comments show intent.
- Never restate the line below in a comment.
- Mark workarounds explicitly: `// Workaround: API returns null instead of 404`

### File & Module Structure
- One class or logical unit per file (except small utility collections).
- Imports at the top, grouped: standard library → external → internal.
- Split files when they grow large — one responsibility per file.

### Surgical File Editing
- **Never rewrite a file wholesale to fix a small problem.** Large files rewritten from memory accumulate transcription errors — each rewrite risks introducing new bugs.
- Before editing any file, **read the current state on disk first** (`view` or `cat`), then identify exactly which lines are wrong.
- Apply the smallest possible diff: change only the lines that are broken. Leave everything else untouched.
- If multiple isolated fixes are needed, make them one at a time with targeted replacements — not a full-file overwrite.
- When a file exceeds ~100 lines, treat a full rewrite as a last resort. The default is always: locate the error, patch the error, verify the patch.

**Patch size tiers — pick the lightest that works:**

| Fix size | Method |
|----------|--------|
| 1-2 lines | Inline markdown patch block (no file write needed) |
| 3–20 lines | `str_replace` on the exact changed block |
| 20+ lines or structural refactor | Targeted file edit or rewrite with `view` verification first |

**Inline patch format** (for 1–2 line fixes): return a markdown code block with an explicit instruction naming the file, the line number or the exact existing code to find, and the replacement. Example:

> In `auth_service.py`, replace line 42:
> ```python
> # Before
> user = db.query(User).filter(User.id == id).first()
> # After
> user = db.get(User, id)  # Use get() for PK lookups — avoids full scan
> ```

Always include both the **before** and **after** snippets so the target is unambiguous even if line numbers shift. Explain *why* on the same line as the fix, not in a separate paragraph.

> **For non-code files (Markdown, DOCX, PDF, configs), also match `working-with-files`.**

> "Rewriting a large file from memory to fix one bug is how one bug becomes ten."

### Deviation Policy
If the user's existing codebase uses different conventions, match their style and note it:
> "Matched your existing `snake_case` convention for consistency with surrounding code."
Never silently mix conventions within a single file.

---

## Layer 2 — Naming Conventions by Language

### JavaScript / TypeScript
| Construct | Style |
|-----------|-------|
| Functions | camelCase |
| Classes | PascalCase |
| Constants | UPPER_SNAKE_CASE |
| Variables | camelCase |
| Types / Interfaces | PascalCase |
| Files | kebab-case |

- Prefer `const` over `let`; never `var`
- Always try/catch or propagate in async functions
- Explicit return types in TypeScript

### Python
| Construct | Style |
|-----------|-------|
| Functions | snake_case |
| Classes | PascalCase |
| Constants | UPPER_SNAKE_CASE |
| Variables | snake_case |
| Private members | _snake_case |
| Files / Modules | snake_case |

- PEP 8: 4-space indent, 79-char line limit
- Type hints on all function signatures
- f-strings preferred over `.format()` or `%`

### Go
| Construct | Style |
|-----------|-------|
| Functions (exported) | PascalCase |
| Functions (unexported) | camelCase |
| Variables | camelCase |
| Constants | PascalCase or camelCase |
| Interfaces | PascalCase noun/adjective |
| Files | snake_case |

- Always handle returned errors — never `_` unless intentional and commented
- Prefer flat over nested

### Rust
| Construct | Style |
|-----------|-------|
| Functions | snake_case |
| Types / Structs / Enums | PascalCase |
| Constants | UPPER_SNAKE_CASE |
| Variables | snake_case |
| Modules / Files | snake_case |

- `Result<T, E>` for all fallible operations — no `.unwrap()` in production
- Use `?` to propagate errors

### Java
| Construct | Style |
|-----------|-------|
| Methods | camelCase |
| Classes | PascalCase |
| Constants | UPPER_SNAKE_CASE |
| Variables | camelCase |
| Packages | lowercase.dot.separated |
| Files | PascalCase (matches class) |

- One public class per file; filename must match class name
- Never swallow exceptions with empty catch blocks

### C#
| Construct | Style |
|-----------|-------|
| Methods | PascalCase |
| Classes | PascalCase |
| Constants | PascalCase |
| Private fields | _camelCase |
| Local variables | camelCase |
| Files | PascalCase (matches class) |

- Never `.Result` or `.Wait()` on tasks — always `async`/`await`
- Follow Microsoft .NET naming guidelines

---

## Fallback — Unlisted Languages
1. Find the language's official style guide (PSR for PHP, Swift API Design Guidelines, etc.)
2. Apply that guide's naming conventions
3. Apply all Layer 1 universal principles without exception
4. State which style guide is being followed at the top of your response

---

## Relationship to Other Skills
| Skill | Role |
|-------|------|
| coding-standards | Naming conventions and universal principles — matched for any coding task |
| coding-examples | Annotated good/bad examples per language — matched alongside core when writing or reviewing code |
| tool-integration | API/tool execution patterns — must also follow these standards |
| reasoning-planning | Use before writing complex code to map structure first |
| working-with-files | Surgical editing for non-code files — match when target is Markdown, DOCX, PDF, config, etc. |

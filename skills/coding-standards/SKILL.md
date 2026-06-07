---
name: coding-standards
description: >
  Use this skill whenever writing, reviewing, or modifying any code in any
  programming language. Enforces universal principles first, then applies
  language-specific naming conventions. Detect language from context (file
  extension, user statement, existing code). If ambiguous, ask before writing
  significant code. Includes annotated good/bad examples per language.
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
| coding-standards | Naming conventions, universal principles, and annotated examples — matched for any coding task |
| tool-integration | API/tool execution patterns — must also follow these standards |
| reasoning-planning | Use before writing complex code to map structure first |
| working-with-files | Surgical editing for non-code files — match when target is Markdown, DOCX, PDF, config, etc. |

---

## Annotated Examples by Language

> Good/bad examples mapping directly to the principles above.

### JavaScript / TypeScript

```typescript
// ✅ Good — guard clause, descriptive name, explicit error handling
const MAX_RETRIES = 3;

async function fetchUserById(userId: string): Promise<User> {
  if (!userId) throw new Error('userId is required');
  try {
    const response = await api.get(`/users/${userId}`);
    return response.data;
  } catch (error) {
    throw new Error(`Failed to fetch user ${userId}: ${error.message}`);
  }
}

// ✅ Good — boolean prefix, named constant, single responsibility
function canRetry(attemptCount: number): boolean {
  return attemptCount < MAX_RETRIES;
}

// ✅ Good — comment explains WHY, not WHAT
// Skip inactive users — billing only applies to active accounts
for (const user of users.filter(u => u.isActive)) {
  processBilling(user);
}

// ❌ Bad — vague name, no guard, no error handling, magic number
async function get(x) {
  return await api.get('/users/' + x).data;
}

// ❌ Bad — comment restates the code
// Loop through users
for (const user of users) { ... }

// ❌ Bad — magic string, no boolean prefix
function check(type) {
  return type === 'admin';
}
// ✅ Fixed
const ROLE_ADMIN = 'admin';
function isAdminUser(role: string): boolean {
  return role === ROLE_ADMIN;
}
```

---

### Python

```python
# ✅ Good — type hints, guard clause, f-string, explicit error propagation
MAX_RETRIES = 3

def fetch_user_by_id(user_id: str) -> User:
    if not user_id:
        raise ValueError("user_id is required")
    try:
        response = api.get(f"/users/{user_id}")
        return response.data
    except ApiError as e:
        raise RuntimeError(f"Failed to fetch user {user_id}: {e}") from e

# ✅ Good — boolean prefix, named constant
def can_retry(attempt_count: int) -> bool:
    return attempt_count < MAX_RETRIES

# ✅ Good — comment explains WHY
# Filter inactive users — billing applies to active accounts only
active_users = [u for u in users if u.is_active]

# ❌ Bad — no type hints, swallowed exception, vague name
def get(x):
    try:
        return api.get('/users/' + x).data
    except:
        pass

# ❌ Bad — magic number, no guard
def process(items):
    if len(items) > 50:
        items = items[:50]
    return items
# ✅ Fixed
MAX_ITEMS = 50

def process_items(items: list) -> list:
    if not items:
        return []
    return items[:MAX_ITEMS]
```

---

### Go

```go
// ✅ Good — exported name, error handling, no ignored returns
const MaxRetries = 3

func FetchUserByID(userID string) (*User, error) {
    if userID == "" {
        return nil, errors.New("userID is required")
    }
    user, err := api.GetUser(userID)
    if err != nil {
        return nil, fmt.Errorf("failed to fetch user %s: %w", userID, err)
    }
    return user, nil
}

// ✅ Good — unexported helper, clear boolean name
func canRetry(attemptCount int) bool {
    return attemptCount < MaxRetries
}

// ❌ Bad — ignored error, vague name, magic value
func get(x string) *User {
    u, _ := api.GetUser(x)
    return u
}

// ❌ Bad — magic number inline
func process(items []Item) []Item {
    if len(items) > 50 {
        return items[:50]
    }
    return items
}
// ✅ Fixed
const MaxItems = 50

func processItems(items []Item) []Item {
    if len(items) > MaxItems {
        return items[:MaxItems]
    }
    return items
}
```

---

### Rust

```rust
// ✅ Good — Result type, ? propagation, guard clause, no unwrap
const MAX_RETRIES: u32 = 3;

fn fetch_user_by_id(user_id: &str) -> Result<User, ApiError> {
    if user_id.is_empty() {
        return Err(ApiError::InvalidInput("user_id is required".into()));
    }
    let user = api::get_user(user_id)?;
    Ok(user)
}

// ✅ Good — boolean name, named constant
fn can_retry(attempt_count: u32) -> bool {
    attempt_count < MAX_RETRIES
}

// ❌ Bad — unwrap in production, vague name
fn get(x: &str) -> User {
    api::get_user(x).unwrap()
}

// ❌ Bad — magic number, panic risk
fn first_item(items: &[Item]) -> &Item {
    &items[0]
}
// ✅ Fixed
fn first_item(items: &[Item]) -> Option<&Item> {
    items.first()
}
```

---

### Java

```java
// ✅ Good — named constant, guard clause, no swallowed exception
private static final int MAX_RETRIES = 3;

public User fetchUserById(String userId) throws UserNotFoundException {
    if (userId == null || userId.isEmpty()) {
        throw new IllegalArgumentException("userId is required");
    }
    return userRepository.findById(userId)
        .orElseThrow(() -> new UserNotFoundException(userId));
}

// ✅ Good — boolean method name
public boolean canRetry(int attemptCount) {
    return attemptCount < MAX_RETRIES;
}

// ❌ Bad — swallowed exception, vague name, returns null silently
public Object get(String x) {
    try {
        return db.find(x);
    } catch (Exception e) {}
    return null;
}

// ❌ Bad — magic number
public List<Item> process(List<Item> items) {
    return items.subList(0, Math.min(items.size(), 50));
}
// ✅ Fixed
private static final int MAX_ITEMS = 50;

public List<Item> processItems(List<Item> items) {
    if (items == null || items.isEmpty()) return Collections.emptyList();
    return items.subList(0, Math.min(items.size(), MAX_ITEMS));
}
```

---

### C#

```csharp
// ✅ Good — async/await, guard clause, null-coalescing throw
private const int MaxRetries = 3;

public async Task<User> FetchUserByIdAsync(string userId)
{
    if (string.IsNullOrEmpty(userId))
        throw new ArgumentException("userId is required", nameof(userId));

    var user = await _userRepository.GetByIdAsync(userId)
        ?? throw new UserNotFoundException(userId);

    return user;
}

// ✅ Good — boolean name, named constant
public bool CanRetry(int attemptCount) => attemptCount < MaxRetries;

// ❌ Bad — .Result blocks thread (deadlock risk), vague name, silent null
public object Get(string x) {
    return db.Find(x).Result;
}

// ❌ Bad — magic number
public List<Item> Process(List<Item> items) =>
    items.Take(50).ToList();
// ✅ Fixed
private const int MaxItems = 50;

public List<Item> ProcessItems(List<Item> items)
{
    if (items is null || !items.Any()) return new List<Item>();
    return items.Take(MaxItems).ToList();
}
```

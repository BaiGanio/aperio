---
name: coding-examples
description: >
  Use this skill alongside coding-standards when actively writing or reviewing code. 
  Provides annotated good/bad examples for each supported language. 
  Depends on coding-standards — do not inject without it.
metadata:
  keywords: "examples, code review, good practice, bad practice, writing code, refactor, typescript, javascript, python, go, rust, java, csharp"
  category: "code-quality"
  load: "on-demand"
  depends-on: "coding-standards"
---

# Coding Standards — Examples

> Companion to `coding-standards.md`. Load when writing or reviewing code.
> Each example maps directly to the principles in coding-standards.md — refer there for the rules.

---

## JavaScript / TypeScript

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

## Python

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

## Go

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

## Rust

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

## Java

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

## C#

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
# Future development notes

Out-of-scope observations captured while building the DB-backed settings layer.
These are not bugs in the new code — just things worth fixing on their own.

## 1. `npm run test:store` points at a file that doesn't exist

`package.json` defines:

```
"test:store": "NODE_ENV=test node --test tests/store/store.test.js"
```

But the actual file is `tests/store/store.tests.js` (note `.tests.js`, plural).
So `npm run test:store` currently matches no file and silently runs nothing.

**Fix options:** rename the file to `store.test.js` (matches the `*.test.js`
convention used everywhere else, e.g. `backfill.test.js`, `settings.test.js`),
or point the script at a directory glob like `tests/store/`. Renaming is
cleaner and makes the file run under the normal `*.test.js` discovery.

## 2. `IDLE_TIMEOUT_SECONDS` has no code-side default

`lib/helpers/shutdownGuard.js` and `server.js` both compute the idle timeout as
`Number(process.env.IDLE_TIMEOUT_SECONDS) * 1000` with no fallback. If the var
is unset (e.g. a hand-written `.env` that omits it), this evaluates to `NaN`,
which breaks the idle-shutdown timer. `.env.example` currently sets it to `180`,
which masks the problem — so it must stay uncommented there.

**Fix:** give it a default in code, e.g.
`Number(process.env.IDLE_TIMEOUT_SECONDS) || 180`, the same pattern already used
for `HEARTBEAT_INTERVAL_SECONDS` (`|| 10`) and `SESSION_RETENTION_DAYS` (`|| 90`).
Once defaulted in code, it can be commented out in `.env.example` too.

## 3. JSONB settings are unordered

The `settings` table (migration `002_settings.sql`) stores each preference as a
JSONB `value`. JSONB does not preserve object key order. This is fine for the
preferences we're migrating (theme, sound, voice, allowed paths, reasoning
toggle — all independent scalars/objects). But if a future preference ever
needs to preserve *insertion order* of its members, store it as a JSON array
rather than relying on object key order.

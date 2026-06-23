
# Aperio Audit Prompt

Use this as the starting prompt for future audit sessions:

You are auditing the Aperio app in this repository. Treat this as a code, architecture, and security posture review. Do not make code changes unless explicitly asked. Prioritize concrete findings with file/line references, then summarize strengths, risks, and recommended next steps.

## Current Assessment

Aperio is a local-first Node/Express + WebSocket personal AI workspace with SQLite/Postgres storage, MCP tools, memory/wiki/codegraph/docgraph features, background agents, and a browser UI.

Overall opinion: the codebase is stronger than expected for a local AI tool. The architecture is reasonably modular, MCP/tool guardrails are thoughtful, and test coverage is broad. It looks fit for personal local use, but its control-plane security depends heavily on the assumption that the app is only reachable by the trusted local user.

## Verification Baseline

Last audit run:

```bash
npm test
```

Result when local networking was allowed:

```text
1570 tests
1570 pass
0 fail
```

Note: inside a restricted sandbox, local listener tests failed with `listen EPERM: operation not permitted 127.0.0.1`. Rerun outside the sandbox or with local network permissions before treating that as an app failure.

## Key Strengths

- The app has a clear local-first architecture and defaults to loopback binding.
- The route layer is split into focused modules instead of one large API file.
- Filesystem access is guarded through an allowlist model.
- Generated artifacts are routed through per-session scratch workspaces.
- Shell execution is opt-in and guarded by a command allowlist.
- Tool execution includes output caps, timeouts, post-write validation, and repeated-failure budgeting.
- Destructive file/GitHub actions use confirmation-token flows.
- Session handling, context summarization, memory loading, and provider switching are tested.
- The test suite is large and currently passes when run with local network permissions.

## Main Risks To Recheck

1. Authentication and trust boundary

The REST API and setup flow appear unauthenticated and rely mainly on loopback binding/private use. This is acceptable for a strictly local desktop tool, but risky if `HOST` is changed or the service is exposed to a LAN/public interface.

Relevant areas:

- `server.js`: app setup, route mounting, bootstrap config endpoint.
- `lib/routes/api-settings.js`: settings CRUD.
- `lib/routes/api-agents.js`: background-agent CRUD and runtime enable switch.
- `lib/routes/api-memories.js`: memory and DB browser endpoints.

Audit questions:

- Is there now an auth/session/API-token layer?
- Are state-changing REST routes protected from CSRF?
- Does the app clearly refuse unsafe `HOST` values unless auth is configured?
- Are setup/config endpoints safe against cross-origin browser requests?

2. WebSocket control-plane power

The WebSocket handler accepts messages that can mutate important runtime state, including filesystem allowlist paths and provider/model selection.

Relevant area:

- `lib/emitters/handlers/wsHandler.js`, especially message types such as `set_paths`, `switch_model`, `confirm_action`, `resume_session`, and `delete_memory`.

Audit questions:

- Does `set_paths` require explicit user confirmation or authenticated UI context?
- Can a malicious page connect to the local WebSocket and send commands?
- Is WebSocket origin checking still present and correct?
- Are non-browser clients intentionally allowed without origin?

3. Filesystem allowlist widening

Aperio has good path guardrails, but some features intentionally widen or persist the allowlist: user-triggered indexing, WebSocket path updates, and indexed repo sync.

Relevant areas:

- `lib/routes/paths.js`
- `lib/routes/api-codegraph.js`
- `lib/routes/api-docgraph.js`
- `lib/emitters/handlers/wsHandler.js`

Audit questions:

- Is allowlist persistence auditable and visible in the UI?
- Can indexing a folder unexpectedly grant write access to that folder?
- Are read and write scopes still unified, or have they been split?
- Are symlinks and non-existent path tails handled safely?

4. Network exposure posture

The server warns when bound to a non-loopback host, and WebSocket origin checks exist, but REST routes need equivalent protection if LAN mode is supported.

Relevant area:

- `server.js`

Audit questions:

- Is `HOST=0.0.0.0` documented as unsafe without authentication?
- Are allowed WebSocket origins configurable for LAN mode?
- Are REST and WebSocket trust policies consistent?

5. Documentation and metadata drift

At the time of this audit, `package.json` showed version `0.56.0`, while `SECURITY.md` still listed `0.48.3` as current stable. This should be rechecked.

Relevant files:

- `package.json`
- `SECURITY.md`
- `README.md`

Audit questions:

- Do supported versions match the current package/release?
- Do security docs accurately describe the local-only threat model?
- Does the README warn users not to expose the web UI/MCP server without auth?

## Suggested Audit Flow

1. Check worktree status first and avoid touching unrelated user changes.
2. Read `package.json`, `README.md`, `SECURITY.md`, `server.js`.
3. Inspect route modules under `lib/routes/`.
4. Inspect WebSocket handling in `lib/emitters/handlers/wsHandler.js`.
5. Inspect path/tool boundaries in `lib/routes/paths.js`, `mcp/tools/files.js`, and `mcp/tools/shell.js`.
6. Run `npm test`. If local listener tests fail with `EPERM`, rerun with local network permissions.
7. Report findings first, ordered by severity, with file/line references.

## Current Verdict

Aperio is a good local-first app with a serious capability surface. It is reasonable as a trusted personal desktop/local tool. Before broader LAN or hosted use, prioritize:

- An auth token or session layer.
- CSRF/origin protection for state-changing REST routes.
- Explicit confirmation for path widening.
- Clear refusal or guarded mode for non-loopback binding.
- Updated security documentation.

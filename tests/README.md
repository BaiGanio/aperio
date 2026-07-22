# Tests

The test tree is organized by execution tier: `unit/` covers isolated logic, `integration/` covers module wiring, and `e2e/` exercises real processes and network protocols. Shared fixtures live in `fixtures/`, reusable test utilities live in `helpers/`, and test reporters live in `reporters/`. The remaining support directories (`lib/`, `mcp/`, and `var/`) contain test-only support code, MCP-specific fixtures, and disposable runtime scratch data respectively. See each tier README for placement rules and commands.

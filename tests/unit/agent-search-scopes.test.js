import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSearchScopes,
  selectSearchScope,
  resolveScopedSearchPath,
} from "../../lib/agent/search-scopes.js";

const RAW = [
  "[PREFERENCE] Auth search (importance: 4)",
  "When auth is mentioned, search /app/auth/oauth/ first.",
  "Tags: project-x, scope:auth",
  "ID: 11111111-1111-1111-1111-111111111111",
  "---",
  "[PREFERENCE] Billing search (importance: 3)",
  "Use /app/billing for invoice work.",
  "Tags: scope:billing, finance",
  "ID: 22222222-2222-2222-2222-222222222222",
].join("\n");

describe("search scope preferences", () => {
  test("parses all matching scope tags and their first paths", () => {
    assert.deepEqual(parseSearchScopes(RAW), [
      { trigger: "auth", path: "/app/auth/oauth/", title: "Auth search", content: "When auth is mentioned, search /app/auth/oauth/ first." },
      { trigger: "billing", path: "/app/billing", title: "Billing search", content: "Use /app/billing for invoice work." },
    ]);
  });

  test("ignores malformed, missing-path, and non-scope memories", () => {
    const raw = [
      "[PREFERENCE] No path (importance: 3)\nSearch auth somewhere.\nTags: scope:auth\nID: a",
      "---",
      "[PREFERENCE] No trigger (importance: 3)\nSearch /app/other.\nTags: preference\nID: b",
    ].join("\n");
    assert.deepEqual(parseSearchScopes(raw), []);
  });

  test("matches the original user query when the generated pattern differs", () => {
    const scopes = parseSearchScopes(RAW);
    assert.equal(
      selectSearchScope(scopes, { userQuery: "find the auth bug", pattern: "OAuthCallback" })?.path,
      "/app/auth/oauth/",
    );
  });

  test("matches trigger terms rather than substrings", () => {
    const scopes = parseSearchScopes(RAW);
    assert.equal(selectSearchScope(scopes, { userQuery: "find the author page" }), null);
  });

  test("prefers a pattern match, then recall order for multiple query matches", () => {
    const scopes = parseSearchScopes(RAW);
    assert.equal(
      selectSearchScope(scopes, { userQuery: "compare auth and billing", pattern: "invoiceTotal" })?.trigger,
      "auth",
    );
    assert.equal(
      selectSearchScope(scopes, { userQuery: "compare auth and billing", pattern: "billing invoice" })?.trigger,
      "billing",
    );
  });

  test("resolves missing, default, relative, contained, and conflicting paths to one path", () => {
    const scope = "/app/auth/oauth";
    assert.equal(resolveScopedSearchPath(scope), scope);
    assert.equal(resolveScopedSearchPath(scope, "."), scope);
    assert.equal(resolveScopedSearchPath(scope, "callbacks"), "/app/auth/oauth/callbacks");
    assert.equal(resolveScopedSearchPath(scope, "/app/auth/oauth/providers"), "/app/auth/oauth/providers");
    assert.equal(resolveScopedSearchPath(scope, "/app/other"), scope);
    assert.equal(resolveScopedSearchPath(scope, "../../../other"), scope);
  });
});

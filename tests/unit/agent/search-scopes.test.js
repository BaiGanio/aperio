import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { resolve } from "node:path";

import {
  parseSearchScopes,
  selectSearchScope,
  resolveScopedSearchPath,
} from "../../../lib/agent/search-scopes.js";

// Fixtures stay POSIX. resolveScopedSearchPath() answers in the host separator and
// anchors a rooted path to the current drive, so on Windows "/app/x" comes back as
// `C:\app\x`. Fold both sides through one helper and derive the expectation with the
// same resolve(), so the assertion is about WHICH path wins, not how it is spelled.
const toKey = (value) => (typeof value === "string" ? value.replaceAll("\\", "/") : value);
const abs = (posixPath) => toKey(resolve(posixPath));

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

  test("parses separator-rooted Windows paths without treating prose escapes as paths", () => {
    const raw = [
      "[PREFERENCE] Shared search (importance: 4)\nSearch \\\\server\\share\\project first.\nTags: scope:shared\nID: a",
      "---",
      "[PREFERENCE] Rooted search (importance: 3)\nSearch \\worktree\\project first.\nTags: scope:rooted\nID: b",
      "---",
      "[PREFERENCE] Prose escape (importance: 2)\nTreat \\n as a newline.\nTags: scope:newline\nID: c",
    ].join("\n");

    assert.deepEqual(parseSearchScopes(raw), [
      {
        trigger: "shared",
        path: "\\\\server\\share\\project",
        title: "Shared search",
        content: "Search \\\\server\\share\\project first.",
      },
      {
        trigger: "rooted",
        path: "\\worktree\\project",
        title: "Rooted search",
        content: "Search \\worktree\\project first.",
      },
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
    assert.equal(toKey(resolveScopedSearchPath(scope)), abs(scope));
    assert.equal(toKey(resolveScopedSearchPath(scope, ".")), abs(scope));
    assert.equal(toKey(resolveScopedSearchPath(scope, "callbacks")), abs("/app/auth/oauth/callbacks"));
    assert.equal(
      toKey(resolveScopedSearchPath(scope, "/app/auth/oauth/providers")),
      abs("/app/auth/oauth/providers"),
    );
    assert.equal(toKey(resolveScopedSearchPath(scope, "/app/other")), abs(scope));
    assert.equal(toKey(resolveScopedSearchPath(scope, "../../../other")), abs(scope));
  });
});

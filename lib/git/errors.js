// lib/git/errors.js
//
// Typed errors for the git_* tool policy/runner core (#343, WS2). Kept
// distinct from a generic Error so callers (WS3-6 tool handlers, WS4's
// confirm chassis) can tell "the policy said no" apart from "git itself
// failed" without string-matching a message.

// The requested repo/operation is outside policy — e.g. a mutating call
// against a repo root that isn't an allowed write path, or a rejected
// plain --force.
export class GitPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitPolicyError";
  }
}

// The caller's arguments don't meet the tool's contract — e.g. git_stage
// called with an empty/missing paths array.
export class GitValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitValidationError";
  }
}

#!/usr/bin/env node
// scripts/release-bump.js — decide the SemVer bump for a release.
//
// Why this is a script and not inline shell: the release workflow used to read
// only `git log -1 --pretty=%s`, the head commit of the push. A push carrying
// `fix: x` followed by `chore: y` therefore saw only the `chore:` and skipped
// the release entirely — that is what ate the 2026-10-17 release. The bump has
// to be computed from EVERY commit since the last version tag, and that logic
// needs a test, which inline shell in a workflow cannot have.
//
// Usage:
//   git log --no-merges --pretty=%s "$LAST_TAG..HEAD" | node scripts/release-bump.js
//
//   --notes-file <path>   also write the counted subjects as markdown bullets
//
// Writes `bump=` / `with_launchers=` / `headline=` to stdout, and appends the
// same lines to $GITHUB_OUTPUT when running inside Actions.
//
// Conventions honoured:
//   feat: / feat(scope):   → minor
//   fix:  / fix(scope):    → patch
//   anything else          → ignored
//   a scope of exactly `launchers` on a counted commit also opts into the
//   launcher-binary build
//   a subject containing `[skip ci]` never counts — that is the shape of the
//   bot's own `chore: release vX [skip ci]` commit, and counting it would let a
//   release trigger the next one
//
// A `!` breaking-change marker (`feat!:`) is read as its base type. Major
// bumps are not automated; cut those by hand.

import { readFileSync, appendFileSync, writeFileSync } from "node:fs";

const SUBJECT_RE = /^(feat|fix)(?:\(([^)]*)\))?!?:\s*(.*)$/;

/**
 * @param {string[]} subjects one commit subject line each
 * @returns {{bump: "minor"|"patch"|"skip", withLaunchers: boolean,
 *            headline: string, counted: {type: string, scope: string,
 *            desc: string, subject: string}[]}}
 */
export function computeBump(subjects) {
  const counted = [];

  for (const raw of subjects) {
    const subject = String(raw).trim();
    if (!subject) continue;
    // The bot's own release commit, and anything else the author marked as
    // non-CI, must not drive the next bump.
    if (subject.includes("[skip ci]")) continue;

    const m = SUBJECT_RE.exec(subject);
    if (!m) continue;

    counted.push({ type: m[1], scope: m[2] ?? "", desc: m[3], subject });
  }

  const feats = counted.filter((c) => c.type === "feat");
  const fixes = counted.filter((c) => c.type === "fix");

  // A single feat outranks any number of fixes.
  const bump = feats.length ? "minor" : fixes.length ? "patch" : "skip";
  const withLaunchers = counted.some((c) => c.scope === "launchers");

  // Newest commit of the winning type — `git log` hands us newest first.
  const winners = bump === "minor" ? feats : bump === "patch" ? fixes : [];
  const headline = winners.length ? winners[0].desc : "";

  return { bump, withLaunchers, headline, counted };
}

// --- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const out = { notesFile: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--notes-file") {
      out.notesFile = argv[i + 1] ?? "";
      i += 1;
    }
  }
  return out;
}

function main() {
  const { notesFile } = parseArgs(process.argv.slice(2));

  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }

  const { bump, withLaunchers, headline, counted } = computeBump(stdin.split("\n"));

  const lines = [
    `bump=${bump}`,
    `with_launchers=${withLaunchers}`,
    `headline=${headline}`,
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
  process.stderr.write(
    `→ bump=${bump}  with_launchers=${withLaunchers}  counted=${counted.length}\n`,
  );

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }

  if (notesFile) {
    // Every counted commit, newest first, so a multi-commit release does not
    // lose the entries the head commit happens not to mention.
    const bullets = counted.map((c) => `- ${c.desc}`).join("\n");
    writeFileSync(notesFile, bullets ? `${bullets}\n` : "");
  }
}

// Only run the CLI when invoked directly, so the test can import computeBump.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}

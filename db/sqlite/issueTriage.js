// db/sqlite/issueTriage.js
// The issue-triage ledger: which GitHub issues the triage agent has already
// looked at, and what it decided (SQLite half).
//
// Split out of db/sqlite/store.js by S3.2 (aperio-reset) — the method bodies
// moved verbatim. The Postgres twin is db/postgres/issueTriage.js; the shared
// contract is tests/integration/db/contract/issue-triage.test.js.
import { nowIso } from './mappers.js';

export const withIssueTriage = (Base) => class extends Base {
  // ── Issue-triage ledger ───────────────────────────────────────────────────
  // updatedAt is GitHub's issue.updated_at and is the dedup key: when it changes
  // the row is reset to pending (triaged_at = NULL) so the issue is re-triaged.
  // `IS` is SQLite's null-safe equality.
  async upsertIssue({ repo, number, title, state, updatedAt }) {
    this.db.prepare(`
      INSERT INTO issue_triage (repo, issue_number, title, state, updated_at)
        VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repo, issue_number) DO UPDATE SET
        title      = excluded.title,
        state      = excluded.state,
        triaged_at = CASE WHEN issue_triage.updated_at IS excluded.updated_at
                          THEN issue_triage.triaged_at ELSE NULL END,
        updated_at = excluded.updated_at
    `).run(repo, number, title ?? null, state ?? null, updatedAt ?? null);
  }

  async listPendingIssues(repo) {
    const sql = repo
      ? `SELECT * FROM issue_triage WHERE triaged_at IS NULL AND repo = ? ORDER BY updated_at`
      : `SELECT * FROM issue_triage WHERE triaged_at IS NULL ORDER BY updated_at`;
    return repo ? this.db.prepare(sql).all(repo) : this.db.prepare(sql).all();
  }

  async markTriaged({ repo, number, priority, verdict, runId }) {
    this.db.prepare(`
      UPDATE issue_triage
         SET triaged_at = ?, priority = ?, verdict = ?, run_id = ?
       WHERE repo = ? AND issue_number = ?
    `).run(nowIso(), priority ?? null, verdict ?? null, runId ?? null, repo, number);
  }
};

// db/postgres/issueTriage.js
// The issue-triage ledger: which GitHub issues the triage agent has already
// looked at, and what it decided (Postgres half).
//
// Split out of db/postgres/store.js by S3.2 (aperio-reset) — the method bodies
// moved verbatim. The SQLite twin is db/sqlite/issueTriage.js; the shared
// contract is tests/integration/db/contract/issue-triage.test.js.

export const withIssueTriage = (Base) => class extends Base {
  // ── Issue-triage ledger ───────────────────────────────────────────────────
  // updatedAt is GitHub's issue.updated_at and is the dedup key: when it changes
  // the row is reset to pending (triaged_at = NULL) so the issue is re-triaged.
  // IS NOT DISTINCT FROM is null-safe equality.
  async upsertIssue({ repo, number, title, state, updatedAt }) {
    await this.pool.query(
      `INSERT INTO issue_triage (repo, issue_number, title, state, updated_at)
         VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (repo, issue_number) DO UPDATE SET
         title      = EXCLUDED.title,
         state      = EXCLUDED.state,
         triaged_at = CASE WHEN issue_triage.updated_at IS NOT DISTINCT FROM EXCLUDED.updated_at
                           THEN issue_triage.triaged_at ELSE NULL END,
         updated_at = EXCLUDED.updated_at`,
      [repo, number, title ?? null, state ?? null, updatedAt ?? null]
    );
  }

  async listPendingIssues(repo) {
    const { rows } = repo
      ? await this.pool.query(
          `SELECT * FROM issue_triage WHERE triaged_at IS NULL AND repo = $1 ORDER BY updated_at`,
          [repo])
      : await this.pool.query(
          `SELECT * FROM issue_triage WHERE triaged_at IS NULL ORDER BY updated_at`);
    return rows;
  }

  async markTriaged({ repo, number, priority, verdict, runId }) {
    await this.pool.query(
      `UPDATE issue_triage
          SET triaged_at = now(), priority = $1, verdict = $2, run_id = $3
        WHERE repo = $4 AND issue_number = $5`,
      [priority ?? null, verdict ?? null, runId ?? null, repo, number]
    );
  }
};

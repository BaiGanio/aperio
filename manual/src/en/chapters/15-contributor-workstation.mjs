export const contributorWorkstation = {
  id: 'chapter.contributor-workstation', number: 15, title: 'Contributor workstation and repository map',
  purpose: 'Prepare an isolated contributor checkout, find the owning layer before editing, and prove the baseline without disturbing another session.',
  audiences: ['Contributor'],
  applicability: { release: 'Repository guidance for Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0', interfaces: 'Node.js ESM source, Express browser server, MCP server, SQLite/Postgres stores, provider loops, tests and scripts.', evidence: 'The pinned tree proves layout and scripts. Current contribution policy may be stricter and must be read from the working tree before change.' },
  sections: [
    { id: 'concept.repository-map', title: 'Follow ownership from entry point to durable effect', paragraphs: [
      'server.js enters the browser application; lib/server.js assembles routes, workers, providers, and shutdown. mcp/index.js composes MCP tools and their shared context. mcp/tools owns tool schemas and handlers; lib/handlers owns reusable behavior. db/index.js selects a backend whose SQLite and Postgres implementations must preserve the same contract.',
      'Provider orchestration, context assembly, path validation, configuration, migrations, and MCP context are high-coupling areas. Read their callers and required regression harness before editing. Search by behavior and exported symbol rather than assuming a filename from current documentation.'
    ], rules: ['Read repository instructions completely.', 'Inspect only task-scoped files and preserve the dirty worktree.', 'Use an isolated scratch database and non-default port for live verification.', 'Never stage broadly or commit without explicit authority.', 'Keep migrations mirrored and generated configuration outputs synchronized when those zones are authorized.'] },
    { id: 'concept.baseline', title: 'A baseline belongs to a checkout and environment', paragraphs: [
      'Record commit, runtime, dependency state, backend, provider, and relevant feature gates before testing. A failure already present at the untouched baseline is evidence, not permission to repair unrelated code.',
      'Prefer focused unit and integration tests first. Start a live server only when the affected flow cannot be exercised in process, then give it disposable state, bounded logs, an owned PID, and explicit teardown.'
    ] }
  ],
  procedures: [{
    id: 'procedure.prepare-contributor-workstation', title: 'Prepare a task-scoped contributor baseline', audience: 'Contributor', goal: 'A pinned isolated checkout has dependencies, a recorded baseline, and one focused test without changing shared runtime state.',
    prerequisites: ['Git and the project’s package manager', 'A task or issue with explicit scope', 'A separate checkout or worktree when concurrent sessions are active'], platforms: 'Shell and path syntax differ. Repository semantics and isolation requirements are common.',
    warning: 'Dependency install can run code and use network access. Do not overwrite another session’s node_modules, database, logs, processes, or uncommitted changes.',
    start: 'Read repository instructions, record the target commit and dirty state, identify no-touch zones, and create an isolated task workspace if needed.',
    steps: [
      { action: 'Verify repository and task identity. List only task-relevant files and locate their tests, callers, generated outputs, and coupling notes.' },
      { action: 'Install dependencies from the lockfile only when required and authorized. Record runtime and package-manager versions plus the first install error.' },
      { action: 'Run the smallest relevant unchanged test to establish baseline. Do not interpret unrelated suite failures as task failures.' },
      { action: 'Trace one affected flow from entry point through handler, store or external boundary, and cleanup owner.' },
      { action: 'If live proof is necessary, allocate a scratch database and non-default port, record its PID, exercise one synthetic flow, and tear it down.' },
      { action: 'Recheck task-scoped status and confirm no unrelated file, process, database, browser profile, or generated artifact was created.' }
    ],
    success: 'The contributor can name the owning modules, baseline result, affected flow, verification command, and cleanup boundary without disturbing concurrent work.', result: 'A bounded workstation baseline is ready for one scoped change.',
    recovery: ['If the tree is dirty in scope, determine ownership before editing; stop on a concurrent conflict.', 'If baseline fails, preserve the exact focused result and distinguish existing failure from task regression.', 'If live teardown fails, stop further work and remove only the exact owned process and scratch state.'],
    reversal: 'Remove only the disposable checkout, scratch database, logs, browser profile, and owned process created for the baseline; leave shared state untouched.', next: ['chapter.change-safely', 'chapter.verify-release', 'chapter.evidence-escalate'], returns: ['role.contributor', 'topic.contributor-technical']
  }],
  generatedProjection: { id: 'projection.chapter-15-facts', title: 'Pinned contributor facts', query: { ids: ['command.test', 'data.repository-entry-points', 'data.dual-backend-contract', 'support.node-source-install'] } }
};

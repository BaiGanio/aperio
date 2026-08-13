export const installDeploy = {
  id: 'chapter.install-deploy', number: 10, title: 'Install and deploy',
  purpose: 'Choose only an evidence-backed installation lane, preserve its storage and inference boundaries, and prove first recall before treating deployment as complete.',
  audiences: ['Everyday user (owner)', 'Operator', 'Integrator'],
  applicability: {
    release: 'Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0',
    interfaces: 'The pinned source tree exposes npm start and npm run mcp. SQLite is the safe zero-configuration backend. Exact Node, operating-system, desktop, container-production, and reverse-proxy support matrices are not release-verified.',
    evidence: 'Package scripts, lockfile, server entry point, database factory, and development Postgres Compose are pinned. Mutable install prose is not used as authority.'
  },
  sections: [
    { id: 'concept.install-lanes', title: 'An installation lane is a support claim', paragraphs: [
      'A source checkout with lockfile-resolved dependencies is the narrowest pinned lane. It can launch browser chat with npm start or standalone MCP with npm run mcp. The release does not declare an exact Node engine or complete operating-system matrix, so a successful local proof is evidence for that environment—not a universal minimum.',
      'SQLite needs no separate database service and is the safest first-success backend. Postgres is multi-process capable and requires pgvector, credentials, connectivity, migrations, and volume ownership. The development Compose file provides a loopback-bound Postgres service. The pinned production Compose path is not presented here because its initdb migration mount conflicts with the repository’s own migration-ownership warning.'
    ], rules: ['Pin the checkout before installing dependencies.', 'Start with SQLite unless Postgres is an explicit requirement.', 'Keep the application and model endpoint private until authentication and proxy behavior are separately verified.', 'Do not call a listening port a complete installation; prove fresh-conversation recall.', 'Record every present-unverified platform or external dependency.'] },
    { id: 'concept.deploy-boundaries', title: 'Storage, inference, network, and process boundaries move independently', paragraphs: [
      'Changing from SQLite to Postgres moves durable data and concurrency behavior; it does not choose a model provider. Changing from llama.cpp to a cloud provider moves prompts and selected recalled context across an inference boundary; it does not migrate the database. Exposing the browser server changes the network boundary; it does not add authentication by implication.',
      'A deployment also owns processes, logs, caches, model weights, database files or volumes, and session artifacts. Record their locations before starting. Cleanup must stop the exact child processes and either retain or deliberately remove each durable location.'
    ] }
  ],
  procedures: [{
    id: 'procedure.install-source-sqlite', title: 'Install the pinned source with isolated SQLite',
    audience: 'Owner or operator proving one source installation', goal: 'The pinned source starts against an isolated SQLite database and completes the canonical first-recall proof without modifying another installation.',
    prerequisites: ['Git and a Node/npm environment capable of installing the pinned lockfile', 'Enough local storage for dependencies and, if selected, model weights', 'A free non-default loopback port', 'An empty disposable directory outside the repository'],
    platforms: 'Command names are pinned; exact Node and operating-system support remain present-unverified. Translate path syntax only, and record the tested runtime and platform.',
    warning: 'Dependency installation may access package registries and execute package lifecycle code. Review the pinned lockfile and use an isolated checkout. Do not expose the server beyond loopback or let a local model download begin unintentionally.',
    start: 'Create a disposable checkout at the pinned commit, an isolated SQLite path, a non-default loopback port, and a log file outside the source tree. Ensure no inherited DATABASE_URL or production credential remains.',
    steps: [
      { action: 'Verify HEAD equals the pinned commit and package.json reports 0.68.0. Install exactly from the lockfile using the available clean-install command; preserve the first error if installation cannot complete.' },
      { action: 'Set DB_BACKEND=sqlite, the isolated SQLite path, the non-default port, and an explicitly selected provider. Keep shell, codegraph, docgraph, and background jobs off unless this test owns them.' },
      { action: 'Start npm start under a process supervisor that records the exact PID and bounded log. Wait for the loopback health or browser endpoint; do not detach an unowned process.' },
      { action: 'Open the local interface and complete Chapter 1’s remember → genuinely fresh conversation → recall procedure with synthetic content.' },
      { action: 'Record runtime, platform, resolved backend, provider, port, database path, and first-recall evidence as an environment result—not a global support claim.' },
      { action: 'Stop the exact process, verify the port is closed, and decide whether to retain the isolated database as evidence before removing the disposable checkout.' }
    ],
    success: 'The pinned source launches on loopback, reports SQLite, completes fresh recall, and shuts down without a leftover process or repository artifact.',
    result: 'One environment-specific source installation is proven from checkout through durable recall and cleanup.',
    recovery: ['If dependency install fails, preserve runtime and package-manager versions plus the first bounded error; do not substitute mutable install instructions.', 'If Postgres is selected or auto-detected unexpectedly, stop and force DB_BACKEND=sqlite before creating test data.', 'If the provider would download weights or send cloud data without prior authorization, stop before first prompt and select an authorized lane.'],
    reversal: 'Stop the recorded process, verify its loopback port is closed, remove only the disposable checkout/cache/database selected for this exercise, and retain no token in logs.',
    next: ['chapter.configure', 'chapter.storage-health', 'chapter.lifecycle'], returns: ['role.owner', 'role.operator', 'topic.configuration-storage-deployment']
  }],
  generatedProjection: { id: 'projection.chapter-10-facts', title: 'Pinned installation facts', query: { ids: ['release.0-68-0', 'command.start', 'support.node-source-install', 'data.sqlite-backend', 'data.postgres-compose-boundary'] } }
};

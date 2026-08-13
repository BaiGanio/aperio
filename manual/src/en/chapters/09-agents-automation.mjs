export const agentsAutomation = {
  id: 'chapter.agents-automation', number: 9, title: 'Agents and automation',
  purpose: 'Define background work while execution is disabled, constrain its tools and data, observe each run, and stop or clean it without orphaned work.',
  audiences: ['Everyday user (owner)', 'Operator', 'Integrator'],
  applicability: {
    release: 'Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0',
    interfaces: 'Browser agent-job routes provide definition CRUD and run history. Execution requires APERIO_AGENT_JOBS=on and an available scheduler/provider.',
    evidence: 'Pinned routes and job normalization establish the lifecycle. A configured job is not evidence that a run occurred or succeeded.'
  },
  sections: [
    { id: 'concept.automation-lifecycle', title: 'Definition, trigger, run, and result are separate records', paragraphs: [
      'A job definition may exist while execution is disabled. Enabling the master gate permits run-now and scheduled or watched triggers; it does not retroactively prove previous work. Each run has its own status, output, error, and interrupt records. Read the run, not the job label, when deciding what happened.',
      'Give a job the smallest tool allowlist, provider boundary, timeout, source scope, and output owner that its task needs. Repeated schedules and watchers can create cost or duplicate effects; verify overlap prevention and the last-run result before adding another trigger.'
    ], rules: ['Define while disabled, inspect, then enable deliberately.', 'Use synthetic inputs for the first run.', 'Treat pending confirmation as paused work, never success.', 'Disable triggers before editing or deleting their dependencies.', 'Retain only the run evidence needed to diagnose or audit the result.'] },
    { id: 'concept.automation-stop', title: 'Stopping input is not always stopping work', paragraphs: [
      'A rejected interrupt prevents its protected tool action, but the surrounding run may still complete with a rejection result. Disabling future triggers does not necessarily cancel an already executing provider request. Use the owning run or process cancellation path, then inspect final status and interrupts before cleanup.',
      'A timeout, provider failure, rejected confirmation, and user interruption have different recovery paths. Preserve the first bounded error, remove the trigger that would repeat it, and retry only after its cause and side-effect state are known.'
    ] }
  ],
  procedures: [{
    id: 'procedure.exercise-background-job', title: 'Create, run, interrupt, and remove a synthetic job',
    audience: 'Owner or operator validating automation', goal: 'One disabled-by-default synthetic job is inspected, run under a deliberate gate, observed through completion or interruption, then removed with no active trigger.',
    prerequisites: ['Browser API access to one isolated database', 'A configured provider suitable for harmless synthetic text', 'No production watcher paths or external write credentials'],
    platforms: 'The HTTP lifecycle is common. Provider availability, schedules, filesystem watchers, and operating-system process controls remain environment-specific.',
    warning: 'Enabling background jobs authorizes execution, not arbitrary scope. Do not point the first job at production paths, mutable external systems, secrets, or an unbounded schedule.',
    start: 'Set background execution off, create an isolated database, and choose a unique job ID with a prompt that returns a fixed synthetic phrase without tools.',
    steps: [
      { action: 'Create the job definition while execution is off. Read it back and inspect normalized provider, tool allowlist, timeout, steps or prompt, and trigger fields.' },
      { action: 'Attempt run-now while disabled and require the explicit disabled response; no run should start.' },
      { action: 'Enable background execution deliberately, run once, and inspect that exact run ID, status, output, error, and interrupts instead of relying on the job’s summary.' },
      { action: 'For an interruption exercise, use a synthetic run whose controlled provider waits for cancellation. Interrupt through the owning control and require terminal interrupted or failed evidence with no later side effect.' },
      { action: 'Disable execution before changing any trigger. Verify no interval or watcher starts another run during the observation window.' },
      { action: 'Delete disposable run history and the job definition, then verify the ID is absent and the scheduler has no active work for it.' }
    ],
    success: 'The disabled gate blocks execution, one deliberate run is attributable, cancellation terminates controlled work, future triggers remain off, and cleanup removes disposable state.',
    result: 'Definition, gate, trigger, run evidence, interruption, retention, and deletion are proven as distinct lifecycle stages.',
    recovery: ['If run-now returns unavailable, keep execution off and inspect scheduler/provider initialization before retrying.', 'If a run remains active after interruption, disable triggers and stop at the owning process boundary; do not delete evidence first.', 'If deletion conflicts with active work, wait for a terminal run state and retry only the exact job ID.'],
    reversal: 'Disable APERIO_AGENT_JOBS, remove triggers, delete the synthetic run and job, close the isolated database, and verify no worker, watcher, timer, or provider request remains.',
    next: ['chapter.install-deploy', 'chapter.configure', 'chapter.troubleshoot'], returns: ['role.everyday-user', 'role.operator', 'topic.integrations-automation']
  }],
  generatedProjection: { id: 'projection.chapter-09-facts', title: 'Pinned automation facts', query: { ids: ['config.APERIO_AGENT_JOBS', 'route.agent-jobs', 'data.agent-run-interrupts', 'data.agent-tool-allowlist'] } }
};

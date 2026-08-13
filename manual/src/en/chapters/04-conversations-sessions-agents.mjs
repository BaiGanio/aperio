export const conversationsSessionsAgents = {
  id: 'chapter.conversations-sessions-agents',
  number: 4,
  title: 'Conversations, sessions, and agents',
  purpose: 'Know what persists when a conversation ends, resume or branch deliberately, and treat background agents as separately governed work.',
  audiences: ['Everyday user (owner)', 'Operator', 'Integrator'],
  applicability: {
    release: 'Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0',
    interfaces: 'Browser and terminal conversation surfaces are distinct. Background-agent definitions and execution are browser API surfaces in the pinned release.',
    evidence: 'Session CRUD and agent-job routes are reachable in the pinned browser server. A representative interface does not establish identical behavior in every client.'
  },
  sections: [
    {
      id: 'concept.conversation-session-memory',
      title: 'Three lifetimes, three cleanup actions',
      paragraphs: [
        'A conversation is the visible exchange with a model. A saved session is Aperio\'s resumable record of that exchange and its summaries. A memory is a separate durable record retrieved across conversations. Closing a conversation does not delete its memories, and forgetting a memory does not delete a saved session.',
        'Branching starts a new conversation from a summary or recent excerpts while preserving the source session. Resuming reopens an existing session. Deleting a session is irreversible for that session record and must not be described as memory cleanup.'
      ],
      rules: [
        'The browser lists sessions with bounded pagination and supports get, pin, and delete by exact session ID.',
        'The terminal creates its own session source and can summarize or hand off, but it is not the browser UI and does not prove browser labels.',
        'Voice capture is a browser/client input path implemented through the browser SpeechRecognition API. Microphone permission and the browser vendor’s recognition boundary are separate from the configured Aperio model provider; after transcription, the text follows the ordinary chat and session path.',
        'Changing provider or model can change what leaves the machine and how much context fits; it does not silently migrate or erase stored memories.'
      ]
    },
    {
      id: 'concept.background-agent',
      title: 'A background agent is a job, not a conversation tab',
      paragraphs: [
        'A job definition can exist while automatic execution is disabled. Running requires the APERIO_AGENT_JOBS gate, a scheduler, and nonempty prompt or steps. Each run has its own result and history; destructive or protected tools may interrupt for a decision.',
        'Before enabling a job, define its data scope, provider, trigger, stop condition, owner, and evidence. After a manual test, inspect the run result and pending interrupts. Disable or delete the job definition only after deciding whether its run history must be retained.'
      ]
    }
  ],
  workedExamples: [
    {
      id: 'example.branch-garden-budget',
      title: 'Explore a budget tangent without rewriting the source conversation',
      for: 'A browser user whose current conversation is designing a garden sensor and who wants to compare battery prices without mixing that tangent into the source session.',
      situation: 'The source session is titled “Garden sensor design” and already contains at least one user message and one answer. It contains no private data.',
      why: 'A branch is a new saved session with bounded context from its parent. It is not a copy of every message, and deleting it does not remove memories.',
      exchanges: [
        {
          speaker: 'You',
          text: 'In the open “Garden sensor design” conversation, choose Branch conversation and send: “Compare two hypothetical battery budgets: €20 and €35.”',
          call: 'Browser action',
          input: 'Branch conversation → send the synthetic budget question',
          expect: 'The client reports a new branch with a distinct ID and a title beginning “↳ Garden sensor design”.',
          explains: 'The pinned server emits session_branched with the child ID and parent ID. Record the child ID before cleanup.'
        },
        {
          speaker: 'You',
          text: 'Open History and inspect both entries.',
          call: 'Browser action',
          input: 'History',
          expect: 'Both “Garden sensor design” and “↳ Garden sensor design” are present as separate sessions.',
          explains: 'If the labels are similar, compare their IDs. Never delete based only on visual position or a truncated title.'
        },
        {
          speaker: 'You',
          text: 'Resume the source session.',
          call: 'Browser action',
          input: 'Select “Garden sensor design” by its source ID',
          expect: 'The source resumes from compact context and does not contain the branch-only battery-budget reply as a rewritten source message.',
          explains: 'Resume reconstructs bounded context; it is not proof that a full transcript was replayed.'
        }
      ],
      failure: 'If Branch reports “Not enough conversation to branch yet,” add one harmless exchange to the source and retry. If either ID is unclear, stop before deletion and inspect History or GET /api/sessions/:id.',
      cleanup: 'Delete only the recorded child session. Refresh History: the child must be absent and the source must remain resumable.',
      takeaway: 'Branch to isolate a tangent; resume to continue saved context; delete by exact session identity. None of these actions is memory cleanup.'
    },
    {
      id: 'example.job-definition-not-execution',
      title: 'Recognize a saved job that has not run',
      for: 'An operator reviewing an automation named “Weekly garden summary” before enabling background execution.',
      situation: 'The job definition exists, but APERIO_AGENT_JOBS is off and no run result is recorded.',
      why: 'A saved definition proves only that configuration was stored. It does not prove the scheduler ran, a provider answered, a tool executed, or cleanup occurred.',
      exchanges: [
        {
          speaker: 'Operator',
          text: 'Inspect the job definition and its run history without enabling it.',
          call: 'Browser/API inspection',
          input: 'Job: Weekly garden summary; execution gate: off; run history: empty',
          expect: 'The job can be listed, while Run now and scheduled execution remain unavailable or non-executing.',
          explains: 'This is a configured job, not a successful automation.'
        },
        {
          speaker: 'Operator',
          text: 'Before any later enablement, write down the provider, allowed tools, data scope, trigger, stop condition, owner, and expected evidence.',
          call: 'Review action',
          input: 'No tool call',
          expect: 'Every authority and lifecycle field has an explicit value; missing values block execution.',
          explains: 'Chapter 9 owns the runnable automation procedure. This example teaches the state distinction and routes there instead of duplicating it.'
        }
      ],
      failure: 'If a run exists unexpectedly, stop and inspect its trigger, result, pending interrupts, and retained artifacts before changing the definition.',
      cleanup: 'No execution occurred. Retain or delete the definition according to its owner; do not describe either choice as cancelling a run.',
      takeaway: 'Definition, trigger, run, interrupt, result, and cleanup are separate states. Never infer one from another.'
    }
  ],
  procedures: [{
    id: 'procedure.branch-and-clean-session',
    title: 'Branch a session and clean up the synthetic branch',
    audience: 'Everyday user (owner) using the Aperio browser interface',
    goal: 'A source session remains intact, a new branch carries bounded context, and the synthetic branch is removed by exact identity.',
    prerequisites: ['A running pinned browser server in isolated synthetic state', 'One short session containing no secrets or personal data'],
    platforms: 'Browser interface only. Terminal and third-party MCP clients have separate session behavior.',
    warning: 'Deleting a saved session cannot be undone and does not delete memories created during it. Record the branch ID and remove only the synthetic branch.',
    start: 'Open the synthetic source session and note its title or ID. Confirm no real session is selected for deletion.',
    steps: [
      { action: 'Choose Branch conversation. Read the boundary notice: the source stays saved and only a summary or recent excerpts cross into the new conversation.' },
      { action: 'Send a harmless message in the branch and confirm it appears only in the new conversation.' },
      { action: 'Open History and verify both source and branch are listed. Resume the source and confirm the branch reply did not rewrite it.' },
      { action: 'Return to History, select only the synthetic branch by exact identity, and delete it.' },
      { action: 'Refresh History and confirm the branch is absent while the source remains resumable.' }
    ],
    success: 'The source session remains unchanged and resumable; the synthetic branch no longer appears.',
    result: 'Branch, resume, and exact-session deletion boundaries have been demonstrated without treating a session as memory.',
    recovery: ['If no summary exists, expect bounded recent-message excerpts rather than inventing a missing summary.', 'If both sessions look identical, stop and compare their IDs before deleting anything.', 'If deletion fails, leave the source untouched and record the sanitized route error.'],
    reversal: 'Session deletion has no reversal. The safe reversal is to delete only the disposable branch and retain the known source; recreate the branch if the test must be repeated.',
    next: ['chapter.agents-automation', 'chapter.privacy-security', 'chapter.evidence-escalate'],
    returns: ['role.everyday-user', 'topic.conversations-sessions', 'topic.agents-providers']
  }, {
    id: 'procedure.inspect-inactive-agent-job',
    title: 'Inspect a background-agent definition without running it',
    audience: 'Operator reviewing stored automation before execution is authorized',
    goal: 'A saved job definition is distinguished from a trigger and run, its authority fields are reviewed, and no execution is inferred or initiated.',
    prerequisites: ['Access to the pinned browser agent-job surface', 'A harmless synthetic job definition with a nonempty prompt or steps'],
    platforms: 'Aperio browser/API surface in v0.68.0. Third-party MCP clients do not inherit this job-management workflow.',
    warning: 'Do not enable APERIO_AGENT_JOBS or choose Run now during this inspection. A definition can name tools and a provider whose execution would cross data or trust boundaries.',
    start: 'Confirm the execution gate reports off. Choose a unique synthetic job ID and verify that no job with that ID already exists.',
    steps: [
      { action: 'Create the disabled synthetic definition with one harmless task and an explicit manual trigger. A definition with neither prompt nor steps must be rejected.' },
      { action: 'List jobs and fetch the exact job ID. Record its provider/model selection, tool allowlist, data scope, trigger, enabled state, timeout or stop condition, and owner.' },
      { action: 'Inspect run history for the same ID. Confirm it is empty; a stored definition and a run record are different evidence.' },
      { action: 'Attempt no execution. If the interface offers Run now while the master gate is off, the pinned API contract is refusal rather than a successful run.' },
      { action: 'Delete only the synthetic definition, list again, and confirm the exact ID is absent.' }
    ],
    success: 'The definition was observable while its run history remained empty, and exact-ID cleanup removed the definition without claiming to cancel or erase a run.',
    result: 'Definition, gate, trigger, run history, and cleanup have been inspected as separate lifecycle states.',
    recovery: ['If run history is not empty, stop and inspect the trigger, verdict, interrupts, retained artifacts, and owner before changing anything.', 'If the definition lacks an authority field, keep execution disabled and route to Chapter 9 before filling it in.', 'If deletion fails, leave the gate off and capture the sanitized exact-ID error.'],
    reversal: 'Deleting the definition has no automatic restore. Recreate only the same synthetic definition if the inspection must be repeated; deleting a definition is not cancellation of an active run.',
    next: ['chapter.agents-automation', 'chapter.privacy-security', 'chapter.evidence-escalate'],
    returns: ['role.operator', 'topic.agents-providers']
  }],
  generatedProjection: {
    id: 'projection.chapter-04-facts',
    title: 'Pinned conversation, session, and agent facts',
    query: { ids: ['interface.browser-chat', 'interface.terminal-chat', 'route.sessions', 'route.agent-jobs', 'config.APERIO_AGENT_JOBS', 'support.provider-interface-divergence'] }
  }
};

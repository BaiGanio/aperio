export const signalModel = {
  id: 'chapter.signal-model',
  number: 2,
  title: 'How Aperio carries a signal',
  purpose: 'Build the smallest safe mental model for understanding what was stored, what crossed a boundary, and what recall evidence means.',
  nonGoals: ['Documenting every provider or storage backend', 'Treating a diagram as product authority', 'Promising full backup'],
  audiences: ['Everyday user (owner)', 'Operator', 'Integrator', 'Contributor'],
  applicability: {
    release: 'Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0',
    evidence: 'Concepts are bounded by the generated Part I authority projection.'
  },
  concepts: [
    {
      id: 'concept.signal-path',
      title: 'The six stations',
      summary: 'A request travels through an agent or client, Aperio, a store, retrieval, assembled context, and back to the agent. Evidence at each boundary tells you whether recall happened.',
      stations: [
        ['1', 'Agent or client', 'Carries your request and decides whether to call an exposed tool.'],
        ['2', 'Aperio tool boundary', 'Validates remember or recall input and records a tool result.'],
        ['3', 'Storage', 'Owns the stored memory and its metadata. Storage is not the model conversation.'],
        ['4', 'Retrieval', 'Uses semantic similarity when available and full-text fallback to select candidates.'],
        ['5', 'Context', 'Returns selected memory to the agent. Sensitivity and provider boundaries apply here.'],
        ['6', 'Answer and evidence', 'The answer is useful only when the tool result shows the signal completed the loop.']
      ],
      takeaway: 'A fluent answer is not proof of recall. The remember result, a fresh conversation, and the recall result are the three observable checkpoints.',
      next: ['procedure.prove-first-recall', 'symptom.recall-empty-after-remember']
    },
    {
      id: 'concept.signal-data-boundaries',
      title: 'Local state and provider boundaries',
      summary: 'Aperio storage and the configured model provider are different boundaries. A normal memory can be returned into model context; sensitive choices require later security guidance.',
      rules: [
        'Use synthetic tier-1 text for first recall.',
        'Treat configured cloud model context as leaving the local storage boundary.',
        'Do not infer privacy from the word local in a client or provider label.',
        'Portable export/import covers selected data and is not a full-system backup.'
      ]
    }
  ],
  checklist: {
    id: 'checklist.signal-evidence',
    title: 'Read the signal before you trust it',
    rows: [
      ['Connection', 'Client reports the Aperio stdio server is live', 'Reconnect the pinned server'],
      ['Exposure', 'remember and recall are visible', 'Inspect server/tool scope'],
      ['Write', 'remember returns success', 'Do not accept conversational confirmation'],
      ['Separation', 'A new conversation was created', 'End the original conversation'],
      ['Read', 'recall returns the stored value', 'Query the harmless word explicitly'],
      ['Cleanup', 'forget removes the synthetic item when requested', 'Retain the returned memory ID']
    ]
  },
  generatedProjection: {
    id: 'projection.part-i-facts',
    title: 'Pinned facts used by Part I',
    query: { ids: ['command.mcp', 'mcp.remember', 'mcp.recall', 'interface.stdio-mcp', 'support.node-source-install', 'support.client-specific-fields', 'data.memory-tier-1', 'data.portable-export'] }
  }
};

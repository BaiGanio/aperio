export const memoryKnowledge = {
  id: 'chapter.memory-knowledge',
  number: 3,
  title: 'Memory and knowledge',
  purpose: 'Use memory for discrete facts and decisions, use wiki articles for reviewed synthesis, and keep both correct, bounded, and removable.',
  audiences: ['Everyday user (owner)', 'Integrator'],
  applicability: {
    release: 'Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0',
    interfaces: 'MCP memory and wiki tools; browser review surfaces are present but their exact labels are not treated as universal client contracts.',
    evidence: 'Tool reachability and handler behavior are read from the pinned composition root. Provider and interface variants remain explicitly bounded.'
  },
  sections: [
    {
      id: 'concept.memory-record',
      title: 'Choose the smallest durable record',
      paragraphs: [
        'A memory is one retrievable record: a fact, preference, project detail, decision, solution, source, person, inference, or workflow. Give it a title that will still make sense outside the conversation and content that can stand on its own.',
        'A wiki article is different. It is a cited synthesis over related memories, addressed by a stable slug and revised in place. Search for an existing article before writing; cite live memory IDs; use a new article only when the topic is genuinely composite or repeatedly consulted.'
      ],
      rules: [
        'Use remember only when the owner explicitly asks to store the record; otherwise propose it for review.',
        'Use an expiry for time-bound context. Expired records stop appearing in current recall; expiry is not secure erasure. If the date is wrong, create a corrected replacement or delete the exact current record instead of waiting for expiry.',
        'Tier 1 is normal. On cloud providers, tier 2 is withheld by default or redacted when configured, and tier 3 is never returned into cloud context.',
        'Updating creates a replacement version and supersedes the prior current record. Forget removes the selected current memory by ID; verify with a new search.'
      ]
    },
    {
      id: 'concept.recall-evidence',
      title: 'Search results are evidence, not certainty',
      paragraphs: [
        'Recall can use semantic search when embeddings are available and full text otherwise. A similarity score ranks candidates; it does not prove that a candidate is true or current. Read the title, content, source, confidence, tier, and dates before acting.',
        'When a query is absent, recall returns a bounded high-priority or recent listing rather than the entire store. Narrow by query, type, tags, language, tier, or point in time instead of assuming an empty or short preview describes everything.'
      ]
    }
  ],
  workedExamples: [
    {
      id: 'example.correct-coffee-grinder-setting',
      title: 'Correct a preference without leaving two current answers',
      for: 'An owner who told an agent the wrong coffee-grinder setting yesterday and wants future agents to use the correction.',
      situation: 'The store contains one harmless tier-1 preference titled “Morning coffee setting” whose content says “Use setting 14.” The intended setting is 16.',
      why: 'Editing by conversation is ambiguous. This example shows the exact record lifecycle: search, inspect the returned ID, create a replacement version, verify the replacement, and remove the synthetic record.',
      exchanges: [
        {
          speaker: 'You',
          text: 'Find my memory about the morning coffee grinder. Use full-text search so this check does not depend on embeddings.',
          call: 'recall',
          input: '{\n  "query": "morning coffee grinder",\n  "search_mode": "fulltext",\n  "type": "preference",\n  "tags": ["manual-c03"],\n  "limit": 5\n}',
          expect: '[PREFERENCE] Morning coffee setting\nUse setting 14.\nTags: manual-c03\nID: 11111111-1111-4111-8111-111111111111',
          explains: 'The UUID shown here is illustrative. In a real run, copy the ID returned by your own recall result.'
        },
        {
          speaker: 'You',
          text: 'Correct that exact memory to “Use setting 16.”',
          call: 'update_memory',
          input: '{\n  "id": "11111111-1111-4111-8111-111111111111",\n  "content": "Use setting 16."\n}',
          expect: '✅ Updated: "Morning coffee setting" (new id: 22222222-2222-4222-8222-222222222222)',
          explains: 'The new ID proves this was a versioned replacement, not an in-place edit. Keep the returned replacement ID.'
        },
        {
          speaker: 'You',
          text: 'Recall the morning coffee grinder preference again.',
          call: 'recall',
          input: '{\n  "query": "morning coffee grinder",\n  "search_mode": "fulltext",\n  "tags": ["manual-c03"]\n}',
          expect: '[PREFERENCE] Morning coffee setting\nUse setting 16.\nTags: manual-c03\nID: 22222222-2222-4222-8222-222222222222',
          explains: 'Success means the corrected content is current. Do not expect the old UUID to remain a current search result.'
        }
      ],
      failure: 'If recall returns nothing, retry with the exact title and full-text mode. If update says the ID was superseded, stop and search again for the current replacement ID.',
      cleanup: 'Call forget with the replacement ID, then repeat the same full-text recall. “No memories found.” is the cleanup evidence.',
      takeaway: 'Use a memory for one independently useful fact or preference. Correct it through the returned ID; never create a competing “correction” memory and hope ranking chooses the right one.'
    },
    {
      id: 'example.synthesize-project-handoff',
      title: 'Turn several cited memories into one project handoff',
      for: 'An owner who repeatedly asks for the state of a small project and needs a reviewed synthesis rather than three disconnected recall results.',
      situation: 'Three harmless memories describe the project goal, the chosen storage backend, and the next milestone. Each recall result has a real UUID.',
      why: 'A wiki article is useful only when it explains a composite topic and cites the memory records that support it. A single fact still belongs in memory.',
      exchanges: [
        {
          speaker: 'You',
          text: 'Search existing wiki articles for “garden sensor handoff” before creating anything.',
          call: 'wiki_search',
          input: '{\n  "query": "garden sensor handoff",\n  "mode": "fulltext",\n  "limit": 5\n}',
          expect: 'No wiki articles matched "garden sensor handoff".',
          explains: 'If a relevant article exists, fetch and revise that stable slug instead of creating a duplicate.'
        },
        {
          speaker: 'You',
          text: 'Create a cited handoff from the three recalled memories.',
          call: 'wiki_write',
          input: '{\n  "slug": "garden-sensor-handoff",\n  "title": "Garden sensor handoff",\n  "summary": "Goal, chosen storage, and next milestone.",\n  "body_md": "## Goal\\nShip a soil-moisture alert [[mem:<goal-id>]].\\n\\n## Decision\\nStore readings in SQLite [[mem:<decision-id>]].\\n\\n## Next milestone\\nTest the threshold outdoors [[mem:<milestone-id>]].",\n  "tags": ["manual-c03", "handoff"],\n  "source_memory_ids": ["<goal-id>", "<decision-id>", "<milestone-id>"]\n}',
          expect: '✅ Created wiki article "Garden sensor handoff" [garden-sensor-handoff] (id: <article-id>, sources: 3)',
          explains: 'Replace angle-bracket placeholders with the live UUIDs returned by recall. The source count must match the intended citations.'
        }
      ],
      failure: 'If the result reports dropped source IDs, do not accept the article as fully grounded. Recall the missing records, repair the citations, and write the same slug again to create a new revision.',
      cleanup: 'This example does not claim a pinned delete operation for wiki articles. Use only synthetic state in an isolated store and discard that store after the exercise.',
      takeaway: 'Memory preserves individual records. Wiki preserves reviewed, cited synthesis. Search first, keep one stable slug, and make missing citations visible.'
    }
  ],
  procedures: [{
    id: 'procedure.maintain-memory',
    title: 'Store, find, correct, and remove a memory',
    audience: 'Everyday user (owner)',
    goal: 'One harmless memory is stored, found, corrected through versioning, and removed with each state transition verified.',
    prerequisites: ['procedure.prove-first-recall', 'A connected agent that exposes remember, recall, update_memory, and forget'],
    platforms: 'Common MCP-tool sequence. Client buttons and tool-result presentation vary and are not prescribed.',
    warning: 'Use synthetic content. A normal tier-1 memory may be returned to the configured model provider. Deletion is by exact memory ID; do not guess an ID or use a broad cleanup request.',
    start: 'Open a fresh conversation and confirm the same Aperio store is connected. Choose a unique synthetic value such as cobalt-17.',
    steps: [
      { action: 'Ask the agent to remember the synthetic record as a fact with a clear title and the tag manual-c03.' },
      { action: 'Inspect the successful remember result and retain the returned memory ID. A conversational acknowledgment alone is not success.' },
      { action: 'Recall cobalt-17 explicitly. Confirm the result has the expected title, content, tag, and ID.' },
      { action: 'Use update_memory with that ID to change cobalt-17 to cobalt-18. Retain the replacement ID returned by the tool.' },
      { action: 'Recall cobalt again. Confirm cobalt-18 is current and the superseded ID is not presented as a current result.' },
      { action: 'Use forget with the replacement ID, then repeat the same recall query.' }
    ],
    success: 'The final recall returns no current manual-c03 memory, while the correction produced a distinct replacement ID before deletion.',
    result: 'The complete create, search, versioned correction, and exact-ID removal lifecycle has been observed with harmless data.',
    recovery: ['If semantic recall misses, repeat with search_mode fulltext and the exact synthetic token.', 'If update reports a superseded record, search for the current replacement and continue only with its returned ID.', 'If forget reports no match, stop; verify the ID from the latest successful result instead of deleting another record.'],
    reversal: 'The forget-and-recall verification is the cleanup. If any duplicate manual-c03 records remain, inspect each exact ID and remove only those synthetic records.',
    next: ['chapter.conversations-sessions-agents', 'chapter.privacy-security', 'chapter.glossary'],
    returns: ['role.everyday-user', 'topic.memory-knowledge']
  }, {
    id: 'procedure.synthesize-wiki-article',
    title: 'Create and verify a cited wiki synthesis',
    audience: 'Everyday user (owner) or integrator maintaining reviewed project knowledge',
    goal: 'One composite topic is written under a stable slug from live memory citations, retrieved, and verified without creating a duplicate article.',
    prerequisites: ['At least two harmless current memories with their returned IDs', 'A connected agent exposing recall, wiki_search, wiki_write, and wiki_get'],
    platforms: 'Common MCP-tool sequence. Browser wiki review surfaces may expose additional controls, but their labels are not prescribed here.',
    warning: 'A wiki article can repeat sensitive memory content in its body. Keep the exercise tier 1 and synthetic. A citation ID is provenance, not a permission boundary, and a dropped citation must not be silently accepted.',
    start: 'Choose a unique synthetic topic and retain the exact IDs of the current memories that support it. Do not use an existing real project slug.',
    steps: [
      { action: 'Recall the synthetic topic and inspect each source record. Confirm every intended citation is current and appropriate to synthesize.' },
      { action: 'Run wiki_search in full-text mode for the proposed topic. If a relevant article exists, use its stable slug rather than creating another canonical home.' },
      { action: 'Draft a short article that explains the composite topic and cites each supporting memory inline as [[mem:<uuid>]].' },
      { action: 'Call wiki_write with the stable slug, body, tags, and the same IDs in source_memory_ids. Inspect the reported source count and any dropped-ID warning.' },
      { action: 'Call wiki_get with the slug. Confirm the breadcrumb, revision, body, inline citations, and Sources list agree.' },
      { action: 'Search the topic again and verify one result resolves to the same slug. A later correction updates this slug and increments its revision; it does not create a sibling correction article.' }
    ],
    success: 'wiki_get returns the intended article and citations, and topic search resolves to one stable slug with the expected revision and source count.',
    result: 'Several discrete memories now support one reviewed synthesis without duplicating the source records or creating competing article homes.',
    recovery: ['If wiki_search finds an existing article, fetch it and decide whether it is the canonical home before writing.', 'If wiki_write reports dropped IDs, recall the missing sources and repair the same slug; do not claim the article is fully grounded.', 'If wiki_get reports the article stale, inspect the changed memories and deliberately revise the same slug before serving it as current.'],
    reversal: 'The pinned MCP surface has no wiki-delete tool. Run this procedure only in an isolated synthetic store that can be discarded, or retain the deliberately created article under its reviewed stable slug.',
    next: ['chapter.conversations-sessions-agents', 'chapter.privacy-security', 'chapter.glossary'],
    returns: ['role.everyday-user', 'topic.memory-knowledge']
  }],
  generatedProjection: {
    id: 'projection.chapter-03-facts',
    title: 'Pinned memory and knowledge facts',
    query: { ids: ['mcp.remember', 'mcp.recall', 'mcp.update_memory', 'mcp.forget', 'mcp.wiki_search', 'mcp.wiki_write', 'data.memory-tiers', 'data.memory-expiry'] }
  }
};

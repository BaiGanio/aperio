export const fullIndex = {
  id: 'chapter.index', number: 26, title: 'Full index',
  purpose: 'Provide an offline, generated route to every authored chapter, concept, symptom record, checklist, procedure, glossary term, and factual catalog family.',
  audiences: ['All readers'],
  applicability: { release: 'This exact semantic manual build.', interfaces: 'Searchable HTML and tagged PDF text with internal links.', evidence: 'Entries derive from semantic source identities at build time. The index is not maintained as a copied list.' },
  sections: [
    { id: 'concept.index-scope', title: 'The index routes; owners explain', paragraphs: ['Entries use stable semantic identities and human labels. A destination may be a canonical procedure, concept, Field Console record, generated catalog row, or navigation route. Follow the destination for applicability and safety.', 'Generated fact families are indexed without reproducing all factual values here; the complete Field Console catalog remains searchable earlier in the book.'], rules: ['Every entry must resolve offline.', 'Duplicate labels retain distinct stable identities.', 'Pseudolocale paths remain internal QA only.', 'Index generation fails on broken destinations.'] },
    { id: 'concept.index-access', title: 'Search text first, then follow structure', paragraphs: ['In HTML, use browser find and internal links. In PDF, use searchable text, bookmarks, and page navigation. Color, images, hover, animation, and network are never required.', 'If a link target is missing, that is a build defect. Do not compensate with an external URL or handwritten page number.'] }
  ],
  backMatter: {
    license: {
      id: 'backmatter.license',
      title: 'License',
      provenance: 'Exact text projected from LICENSE at the v0.68.0 product pin; legal.license records its blob identity.',
      paragraphs: [
        'MIT License',
        'Copyright (c) 2025 BaiGanio',
        'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
        'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.',
        'THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.'
      ]
    },
    acknowledgments: {
      id: 'backmatter.acknowledgments',
      title: 'Acknowledgments and asset disposition',
      paragraphs: [
        'This review build uses the repository-authored Night Receiver, Signal Desk, and Field Console prototype family, existing Aperio mascot assets, and one prototype settings facsimile. The mascot, facsimile, and color are nonessential to every instruction.',
        'Embedded preview typefaces are Bricolage Grotesque, Instrument Sans, and DM Mono from repository-local design assets. Their complete release rights record and locked complete-script font profile remain external candidate blockers; this NON-RELEASE packet does not convert repository presence into publication clearance.',
        'No third-party screenshot, user data, credential, or network-fetched asset is incorporated. Release assets remain governed by their own approval and rights manifests.'
      ]
    },
    support: {
      id: 'backmatter.support-links',
      title: 'Canonical source, support, and history links',
      paragraphs: [
        'The manual is complete offline. These links are supplementary mutable network routes, except where the URL embeds the immutable product commit. Their availability is not a support promise.',
        'Report a problem only after following Chapters 18–19. Attach bounded synthetic evidence; never attach credentials, private memories, an unrestricted database, or an unredacted home path. Changelog history is linked rather than reproduced so this edition cannot silently rewrite it.'
      ],
      links: [
        ['Pinned v0.68.0 source tree', 'https://github.com/BaiGanio/aperio/tree/65d45c971c51c9c83a7d3faf34def61dd4d841e0'],
        ['Pinned v0.68.0 license', 'https://github.com/BaiGanio/aperio/blob/65d45c971c51c9c83a7d3faf34def61dd4d841e0/LICENSE'],
        ['Pinned v0.68.0 changelog', 'https://github.com/BaiGanio/aperio/blob/65d45c971c51c9c83a7d3faf34def61dd4d841e0/CHANGELOG.md'],
        ['Issue tracker', 'https://github.com/BaiGanio/aperio/issues']
      ]
    }
  },
  procedures: [{ id: 'procedure.use-full-index', title: 'Find a task or concept offline', audience: 'Any reader', goal: 'A term, symptom, command, capability, or procedure is found without network access.', prerequisites: ['The English HTML or PDF artifact'], platforms: 'Search shortcut and PDF viewer vary; text and stable labels are common.', warning: 'A search result is a route, not authority to run a command or approve a mutation.', start: 'Choose the most specific noun, error fragment, stable ID, command, or outcome.', steps: [{ action: 'Search the index text for the exact phrase, then a shorter stable noun.' }, { action: 'Choose the entry whose type and chapter match the task.' }, { action: 'Follow the internal link in HTML or use the labeled PDF destination.' }, { action: 'Read applicability, evidence status, and warning at the destination.' }, { action: 'Follow the canonical procedure or generated source link; do not act from the index label.' }, { action: 'Return through the destination’s next-task or role route.' }], success: 'The desired owner is reachable offline and the reader sees its evidence and safety boundary.', result: 'The index shortens navigation without creating a second source of truth.', recovery: ['Try a stable ID or glossary synonym.', 'Use the contents or role routes if the label is broad.', 'Report a missing or broken destination as a build defect.'], reversal: 'No product state changes.', next: ['navigation', 'contents', 'chapter.glossary'], returns: ['navigation', 'role.all'] }],
  generatedProjection: { id: 'projection.chapter-26-facts', title: 'Catalog families and legal identity', query: { ids: ['release.0-68-0', 'data.repository-entry-points', 'legal.license'] } }
};

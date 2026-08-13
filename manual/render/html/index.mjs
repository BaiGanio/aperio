import { book } from '../../src/en/book.mjs';
import { firstRecall } from '../../src/en/chapters/01-first-recall.mjs';
import { signalModel } from '../../src/en/chapters/02-signal-model.mjs';
import { memoryKnowledge } from '../../src/en/chapters/03-memory-knowledge.mjs';
import { conversationsSessionsAgents } from '../../src/en/chapters/04-conversations-sessions-agents.mjs';
import { toolsFilesArtifacts } from '../../src/en/chapters/05-tools-files-artifacts.mjs';
import { codeDocumentKnowledge } from '../../src/en/chapters/06-code-document-knowledge.mjs';
import { connectAgentClient } from '../../src/en/chapters/07-connect-agent-client.mjs';
import { integrationsExternalData } from '../../src/en/chapters/08-integrations-external-data.mjs';
import { agentsAutomation } from '../../src/en/chapters/09-agents-automation.mjs';
import { installDeploy } from '../../src/en/chapters/10-install-deploy.mjs';
import { configure } from '../../src/en/chapters/11-configure.mjs';
import { storageHealth } from '../../src/en/chapters/12-storage-health.mjs';
import { privacySecurity } from '../../src/en/chapters/13-privacy-security.mjs';
import { lifecycle } from '../../src/en/chapters/14-lifecycle.mjs';
import { contributorWorkstation } from '../../src/en/chapters/15-contributor-workstation.mjs';
import { changeSafely } from '../../src/en/chapters/16-change-safely.mjs';
import { verifyRelease } from '../../src/en/chapters/17-verify-release.mjs';
import { troubleshoot } from '../../src/en/chapters/18-troubleshoot.mjs';
import { evidenceEscalate } from '../../src/en/chapters/19-evidence-escalate.mjs';
import { releaseSupport } from '../../src/en/chapters/20-release-support.mjs';
import { configurationCatalog } from '../../src/en/chapters/21-configuration-catalog.mjs';
import { commandsChecks } from '../../src/en/chapters/22-commands-checks.mjs';
import { capabilityCatalog } from '../../src/en/chapters/23-capability-catalog.mjs';
import { dataPortability } from '../../src/en/chapters/24-data-portability.mjs';
import { glossary } from '../../src/en/chapters/25-glossary.mjs';
import { fullIndex } from '../../src/en/chapters/26-index.mjs';
import { project } from '../../lib/data/index.mjs';
import { visualSystemCss } from '../../styles/visual-system.mjs';
import { applyFontAssets } from '../../preview/assets.mjs';

const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const href = (id) => `#${esc(id)}`;
const bullets = (items) => `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const destinationLabels = new Map([
  ...book.parts.flatMap((part) => part.chapters),
  ...firstRecall.procedures.map((item) => [item.id, item.title]),
  ...memoryKnowledge.procedures.map((item) => [item.id, item.title]),
  ...conversationsSessionsAgents.procedures.map((item) => [item.id, item.title]),
  ...toolsFilesArtifacts.procedures.map((item) => [item.id, item.title]),
  ...codeDocumentKnowledge.procedures.map((item) => [item.id, item.title]),
  ...connectAgentClient.procedures.map((item) => [item.id, item.title]),
  ...integrationsExternalData.procedures.map((item) => [item.id, item.title]),
  ...agentsAutomation.procedures.map((item) => [item.id, item.title]),
  ...installDeploy.procedures.map((item) => [item.id, item.title]),
  ...configure.procedures.map((item) => [item.id, item.title]),
  ...storageHealth.procedures.map((item) => [item.id, item.title]),
  ...privacySecurity.procedures.map((item) => [item.id, item.title]),
  ...lifecycle.procedures.map((item) => [item.id, item.title]),
  ...contributorWorkstation.procedures.map((item) => [item.id, item.title]),
  ...changeSafely.procedures.map((item) => [item.id, item.title]),
  ...verifyRelease.procedures.map((item) => [item.id, item.title]),
  ...troubleshoot.procedures.map((item) => [item.id, item.title]),
  ...evidenceEscalate.procedures.map((item) => [item.id, item.title]),
  ...[releaseSupport, configurationCatalog, commandsChecks, capabilityCatalog, dataPortability].flatMap((chapter) => chapter.procedures.map((item) => [item.id, item.title])),
  ...[glossary, fullIndex].flatMap((chapter) => chapter.procedures.map((item) => [item.id, item.title])),
  [firstRecall.symptom.id, firstRecall.symptom.title],
  [signalModel.checklist.id, signalModel.checklist.title]
]);
const destinationLabel = (id) => destinationLabels.get(id) || id;

function page({ id, role = 'signal-desk', route = 'Manual preview', signal = 'review', content, className = '' }) {
  const classes = ['manual-page', role, className].filter(Boolean).join(' ');
  return `<section class="${classes}" id="${esc(id)}"><span class="page-mark">NON-RELEASE</span><div class="running-top"><span>${esc(route)}</span><span class="signal-id">${esc(signal)}</span></div>${content}<div class="running-bottom"><span>NON-RELEASE / Aperio 0.68.0 / English</span><span>review packet</span></div></section>`;
}

function chapterHead(number, eyebrow, title, lede) {
  return `<div class="chapter-head"><p class="chapter-number">${esc(number)}</p><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1><p class="lede">${esc(lede)}</p></div></div>`;
}

function orientation(item) {
  return `<dl class="orientation"><div><dt>Audience</dt><dd>${esc(item.audience)}</dd></div><div><dt>Goal and outcome</dt><dd>${esc(item.goal)}</dd></div><div><dt>Prerequisites</dt><dd>${item.prerequisites.map(esc).join('; ')}</dd></div><div><dt>Platform applicability</dt><dd>${esc(item.platforms)}</dd></div></dl>`;
}

function procedure(item, number, route = 'Part I / First recall', extra = '') {
  if (!item) return '';
  const splitActions = JSON.stringify(item).length > 2600;
  const firstSteps = splitActions ? item.steps.slice(0, 3) : item.steps;
  const remainingSteps = splitActions ? item.steps.slice(3) : [];
  const renderSteps = (steps) => steps.map((step) => `<li><div><p>${esc(step.action)}</p>${step.code ? `<pre><code>${esc(step.code)}</code></pre>` : ''}${step.quote ? `<blockquote>${esc(step.quote)}</blockquote>` : ''}</div></li>`).join('');
  const actions = `${chapterHead(number, 'Canonical procedure', item.title, item.goal)}${orientation(item)}<aside class="warning" aria-label="Safety and data boundary warning"><p><span class="callout-label">Warning.</span> ${esc(item.warning)}</p></aside><h2>Starting state</h2><p>${esc(item.start)}</p><h2>Actions</h2><ol class="steps">${renderSteps(firstSteps)}</ol>${extra}`;
  const actionsContinued = splitActions ? page({ id: `${item.id}.actions-continued`, route, signal: `${number} / actions continued`, content: `<p class="eyebrow">Canonical procedure / actions continued</p><h1>${esc(item.title)}</h1><p class="lede">Continue from the same starting state and warning; this is not a second procedure.</p><ol class="steps" start="4">${renderSteps(remainingSteps)}</ol><p class="provenance">Continuation of <code>${esc(item.id)}</code>.</p>`, className: 'procedure' }) : '';
  const outcome = `<p class="eyebrow">Canonical procedure / continued</p><h1>${esc(item.title)}</h1><p class="lede">Confirm the result, recover without widening the failure, then reverse the synthetic change when review is complete.</p><div class="result-grid"><section class="result success"><p class="component-label">Success and result</p><p>${esc(item.success)}</p><p>${esc(item.result)}</p></section><section class="result recovery"><p class="component-label">Recovery</p>${bullets(item.recovery)}</section></div><section class="reversal"><p class="component-label">Reverse or clean up</p><p>${esc(item.reversal)}</p></section><h2>Next tasks</h2><ul>${item.next.map((id) => `<li><a href="${href(id)}">${esc(destinationLabel(id))}</a></li>`).join('')}</ul><p class="provenance">Return routes: ${item.returns.map(esc).join(' | ')}. This continuation is part of <code>${esc(item.id)}</code>, not a second instruction.</p>`;
  return page({ id: item.id, route, signal: `${number} / procedure`, content: actions, className: 'procedure' }) + actionsContinued + page({ id: `${item.id}.outcome`, route, signal: `${number} / outcome`, content: outcome });
}

function navigationPages() {
  const tasks = page({
    id: 'navigation', route: 'Routes / I want to...', signal: '01 / choose', number: 2,
    content: `<p class="eyebrow">Canonical route page</p><h1>I want to...</h1><p class="lede">Choose an outcome. Every route points into one canonical instruction; no route carries a duplicate copy.</p><nav class="route-panel" aria-label="Task routes"><p class="route-label">Choose a frequency</p><div class="route-panel-grid">${book.taskRoutes.map(([label, id], index) => `<article class="route-card"><p class="eyebrow">Route ${index + 1}</p><h3><a href="${href(id)}">${esc(label)}</a></h3><p>Canonical destination: <code>${esc(id)}</code></p></article>`).join('')}</div></nav>`
  });
  const topics = page({
    id: 'browse', route: 'Routes / topics and roles', signal: '02 / orient', number: 3,
    content: `<p class="eyebrow">Canonical landing page</p><h1>Browse by topic</h1><ul class="topic-list">${book.topics.map(([label, id]) => `<li><a href="${href(id)}">${esc(label)}</a></li>`).join('')}</ul><h2>Four role routes</h2><div class="role-grid">${book.roles.map((role) => `<article class="role-card" id="${esc(role.id)}"><h3>${esc(role.title)}</h3><ol>${role.links.map((id) => `<li><a href="${href(id)}">${esc(destinationLabel(id))}</a></li>`).join('')}</ol></article>`).join('')}</div>`
  });
  return tasks + topics;
}

function contentsPage() {
  let chapter = 0;
  return page({
    id: 'contents', route: 'Contents / canonical shell', signal: '03 / scan', number: 4,
    content: `<p class="eyebrow">Seven parts / 26 planned canonical chapters</p><h1>Contents</h1><p class="lede">Chapters 1–2 retain their approved content. Chapters 3–4 are the current editorial checkpoint. Later chapter drafts are not approved reader guidance.</p><p class="provenance">Generated catalogs are pinned factual inputs; they never replace explanation, procedure, recovery, or narrative.</p><nav class="toc-grid" aria-label="Seven parts and 26 chapters">${book.parts.map((part, index) => `<section class="toc-part"><h2>Part ${roman[index]} / ${esc(part.title)}</h2><ol start="${chapter + 1}">${part.chapters.map(([id, title]) => { chapter += 1; return `<li><a href="${href(id)}">${esc(title)}</a></li>`; }).join('')}</ol></section>`).join('')}</nav>`
  });
}

function cover(edition, assets) {
  return page({
    id: 'cover', role: 'night', route: 'Aperio manual / review preview', signal: '00 / tune in', number: 1, className: 'cover',
    content: `<div class="cover-grid"><div class="cover-copy"><p class="eyebrow">Product 0.68.0 / English / NON-RELEASE</p><h1>Make recall<br>part of the path</h1><p>Aperio gives agents a durable, self-hosted memory layer. This preview carries one safe first signal from a pinned checkout to recall in a fresh conversation.</p><div class="cover-actions"><a href="#navigation">I want to...</a><a href="#contents">Browse the book</a></div><p class="provenance">Product commit<br><code>${esc(edition.product.sha)}</code></p></div><figure class="cover-art"><div class="aurora-window"><img src="${assets.mascotCover}" alt="Aperio's small retro-radio robot lit by violet, pink, and cyan aurora bands."></div><figcaption>The approved Night Receiver cover role. The mascot is selective and nonessential.</figcaption></figure></div><nav class="cover-route" aria-label="Primary manual routes"><p class="route-label">Choose a frequency</p><ol><li><a href="#chapter.first-recall"><span>01</span><span class="em">First recall</span><small>Install, connect, remember</small></a></li><li><a href="#navigation"><span>02</span><span class="em">I want to...</span><small>Choose an outcome</small></a></li><li><a href="#contents"><span>03</span><span class="em">Browse</span><small>Topics, roles, chapters</small></a></li></ol></nav>`
  });
}

function partOpener() {
  return page({
    id: 'part.tune-in', role: 'night', route: 'Part I / opener', signal: '04 / receive', number: 5, className: 'part-opener',
    content: `<p class="part-number">Part I / Tune in</p><h1>Catch one signal.<br>Prove it returns.</h1><p class="lede">Install the pinned product, connect one agent, store one harmless memory, and retrieve it in a genuinely fresh conversation.</p><div class="frequency-scale" aria-label="Seven-part book position">${book.parts.map((part, index) => `<span>${roman[index]}<br>${esc(part.title)}</span>`).join('')}</div>`
  });
}

function usePartOpener() {
  return page({
    id: 'part.use', role: 'night', route: 'Part II / opener', signal: '15 / use', className: 'part-opener',
    content: `<p class="part-number">Part II / Use Aperio</p><h1>Keep the signal<br>useful and bounded.</h1><p class="lede">Maintain memories and knowledge, understand what a session preserves, and give agents only the scope their work needs.</p><div class="frequency-scale" aria-label="Seven-part book position">${book.parts.map((part, index) => `<span>${roman[index]}<br>${esc(part.title)}</span>`).join('')}</div>`
  });
}

function chapterPage(chapter, route, facts) {
  const projectedFacts = project(facts, chapter.generatedProjection.query);
  const shownFacts = projectedFacts.length > 12 ? projectedFacts.slice(0, 6) : projectedFacts;
  const factLinks = shownFacts.map(({ id }) => `<li><a href="#${esc(id)}"><code>${esc(id)}</code></a></li>`).join('') + (projectedFacts.length > shownFacts.length ? `<li><a href="#${esc(projectedFacts[shownFacts.length].id)}">Continue through all ${projectedFacts.length} generated rows</a></li>` : '');
  const landing = page({
    id: chapter.id, route, signal: `${String(chapter.number).padStart(2, '0')} / orient`,
    content: `${chapterHead(String(chapter.number).padStart(2, '0'), 'Canonical chapter', chapter.title, chapter.purpose)}<dl class="orientation"><div><dt>Audiences</dt><dd>${esc(chapter.audiences.join(', '))}</dd></div><div><dt>Applicability</dt><dd>${esc(chapter.applicability.release)}</dd></div><div><dt>Interfaces</dt><dd>${esc(chapter.applicability.interfaces)}</dd></div><div><dt>Evidence boundary</dt><dd>${esc(chapter.applicability.evidence)}</dd></div></dl><h2>Canonical procedures</h2><ol>${[...chapter.procedures.map((item) => item.id), ...(chapter.procedureLinks ?? [])].map((id) => `<li><a href="${href(id)}">${esc(destinationLabel(id))}</a></li>`).join('')}</ol><h2>Pinned factual basis</h2><p>These links resolve to rows in the one generated catalog; this chapter does not maintain a copied fact list.</p><ul>${factLinks}</ul><p class="provenance">Normalized dataset ${esc(facts.provenance.semanticHash)} / product ${esc(facts.provenance.productSha)}</p>`
  });
  const concepts = chapter.sections.map((section, index) => page({
    id: section.id, route, signal: `${String(chapter.number).padStart(2, '0')}.${index + 1} / understand`,
    content: `<p class="eyebrow">Concepts and boundaries</p><h1>${esc(section.title)}</h1><p class="lede">${esc(chapter.title)}: use this distinction before changing durable state.</p>${section.paragraphs.map((paragraph) => `<p>${esc(paragraph)}</p>`).join('')}${section.rules ? bullets(section.rules) : ''}<p class="provenance">Canonical concept owned by <code>${esc(chapter.id)}</code>.</p>`
  })).join('');
  return landing + concepts + workedExamplePages(chapter, route);
}

function workedExamplePages(chapter, route) {
  return (chapter.workedExamples ?? []).map((example, exampleIndex) => {
    const exchanges = example.exchanges.map((exchange, exchangeIndex) => page({
      id: exchangeIndex === 0 ? example.id : `${example.id}.${exchangeIndex + 1}`,
      route,
      signal: `${String(chapter.number).padStart(2, '0')}.E${exampleIndex + 1}.${exchangeIndex + 1} / try`,
      content: `${exchangeIndex === 0 ? `${chapterHead(`${String(chapter.number).padStart(2, '0')}E`, 'Worked example', example.title, example.for)}<section class="example-setup"><h2>Situation</h2><p>${esc(example.situation)}</p><h2>What this teaches</h2><p>${esc(example.why)}</p></section>` : `<p class="eyebrow">Worked example / continued</p><h1>${esc(example.title)}</h1>`}<section class="example-turn"><p class="component-label">${esc(exchange.speaker)} / ${esc(exchange.call)}</p><blockquote>${esc(exchange.text)}</blockquote><h2>Input or action</h2><pre><code>${esc(exchange.input)}</code></pre><h2>Expected observable result</h2><pre><code>${esc(exchange.expect)}</code></pre><p><span class="em">Why this matters:</span> ${esc(exchange.explains)}</p></section>${exchangeIndex === example.exchanges.length - 1 ? `<div class="result-grid"><section class="result recovery"><p class="component-label">If it does not match</p><p>${esc(example.failure)}</p></section><section class="result success"><p class="component-label">Cleanup</p><p>${esc(example.cleanup)}</p></section></div><section class="reversal"><p class="component-label">What you learned</p><p>${esc(example.takeaway)}</p></section>` : `<p class="provenance">Continue this same example on the next page.</p>`}`
    })).join('');
    return exchanges;
  }).join('');
}

function chapterOneLanding() {
  return page({
    id: 'chapter.first-recall', route: 'Part I / Chapter 1', signal: '05 / first recall', number: 6,
    content: `${chapterHead('01', 'First-success route', firstRecall.title, firstRecall.purpose)}<dl class="orientation"><div><dt>Audiences</dt><dd>${esc(firstRecall.audiences.join(', '))}</dd></div><div><dt>Canonical interface</dt><dd>${esc(firstRecall.applicability.interface)}</dd></div><div><dt>Applicability</dt><dd>${esc(firstRecall.applicability.release)}</dd></div><div><dt>Evidence status</dt><dd>${esc(firstRecall.applicability.evidence)}</dd></div></dl><aside class="warning"><p><span class="callout-label">Finish line.</span> Installation alone does not complete this route. Finish only after one agent is connected, one harmless memory is stored, and the value is recalled in a fresh conversation.</p></aside><h2>Three canonical procedures</h2><ol>${firstRecall.procedures.map((item) => `<li><a href="${href(item.id)}">${esc(item.title)}</a></li>`).join('')}</ol><h2>Support boundary</h2><p>The pinned code establishes the source entry point and memory tools. Exact Node compatibility, operating-system support, and client field labels remain present-unverified.</p><p class="provenance">Authority: product ${esc(firstRecall.applicability.release)}. Mutable README, FEATURES, and current docs were not used as factual authority.</p>`
  });
}

function platformPage(assets) {
  return page({
    id: 'platform-applicability', route: 'Part I / Applicability', signal: '08 / lanes', number: 9,
    content: `${chapterHead('01A', 'Genuine platform lanes', 'Keep path syntax in its lane', 'The Aperio command is common. Only the absolute working-directory syntax diverges here; support status does not.')}
    <div class="platform-lanes" role="group" aria-label="Platform-specific absolute path examples"><section class="platform-lane mac"><h3><span>macOS / present-unverified</span>POSIX path</h3><p>Use the pinned checkout as the client working directory.</p><code>/Users/me/aperio</code></section><section class="platform-lane windows"><h3><span>Windows / present-unverified</span>Windows path</h3><p>Use the same pinned checkout intent with Windows path syntax.</p><code>C:\\Users\\me\\aperio</code></section><section class="platform-lane linux"><h3><span>Linux / present-unverified</span>POSIX path</h3><p>Use the pinned checkout as the client working directory.</p><code>/home/me/aperio</code></section></div>
    <aside class="warning"><p><span class="callout-label">Applicability boundary.</span> These lanes demonstrate a real path-syntax divergence. They do not claim that v0.68.0 has passed an exact platform or client support matrix.</p></aside>
    <figure class="screenshot-figure"><div class="screenshot-frame"><span class="screen-label">v0.68.0-labeled illustrative facsimile / approved prototype source</span><img src="${assets.facsimile}" alt="Illustrative Aperio settings panel with provider and storage controls plus three numbered annotation pins."></div><figcaption><span class="caption-number">Figure 1.1.</span> Preview-only semantic facsimile. It is not procedure evidence, and no action depends on seeing it.</figcaption></figure><ol class="annotation-key"><li><span>1</span><p>Provider controls cross an inference boundary.</p></li><li><span>2</span><p>Storage selection is a different boundary.</p></li><li><span>3</span><p>Source labels explain where a value came from.</p></li></ol>`
  });
}

function symptomPage() {
  const item = firstRecall.symptom;
  return page({
    id: item.id, role: 'field-console', route: 'Part I / Symptom record', signal: '10 / diagnose', number: 11,
    content: `<section class="console-box"><header><div><p class="component-label">Symptom record</p><h1>${esc(item.title)}</h1></div><span class="status">${esc(item.severity)}</span></header><h2>Observed</h2><p>${esc(item.observed)}</p><h2>Least destructive checks first</h2>${item.checks.map((check, index) => `<div class="symptom-row"><span class="meter-mark">${String.fromCharCode(65 + index)}</span><p>${esc(check)}</p></div>`).join('')}<h2>Recovery and verification</h2><p>${esc(item.recovery)} ${esc(item.verify)}</p><h2>Reversal</h2><p>${esc(item.reversal)}</p></section><p><a href="#procedure.prove-first-recall">Return to the canonical first-recall procedure</a>.</p>`
  });
}

function symptomRecords(chapter, route) {
  return (chapter.records ?? []).map((item, index) => page({
    id: item.id, role: 'field-console', route, signal: `${String(chapter.number).padStart(2, '0')}.${index + 1} / inspect`,
    content: `<section class="console-box"><header><div><p class="component-label">${chapter.number === 19 ? 'Evidence checklist' : 'Symptom record'}</p><h1>${esc(item.title)}</h1></div><span class="status">${esc(item.severity)}</span></header><h2>Observed</h2><p>${esc(item.observed)}</p><h2>Least destructive checks first</h2>${item.checks.map((check, checkIndex) => `<div class="symptom-row"><span class="meter-mark">${String.fromCharCode(65 + checkIndex)}</span><p>${esc(check)}</p></div>`).join('')}<h2>Recovery and verification</h2><p>${esc(item.recovery)} ${esc(item.verify)}</p><h2>Reversal</h2><p>${esc(item.reversal)}</p></section><p><a href="#${esc(chapter.procedures[0].id)}">Continue to the canonical procedure</a>.</p>`
  })).join('');
}

const termId = (term) => `term.${term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

function glossaryPages() {
  const chunks = [];
  for (let index = 0; index < glossary.terms.length; index += 8) chunks.push(glossary.terms.slice(index, index + 8));
  return chunks.map((terms, index) => page({
    id: index === 0 ? 'glossary-terms' : `glossary-terms.${index + 1}`, role: 'field-console', route: 'Part VII / Chapter 25', signal: `25.${index + 1} / define`,
    content: `<section class="console-box"><header><div><p class="component-label">Glossary${index ? ' / continued' : ''}</p><h1>Terms and distinctions</h1></div><span class="status">Field Console</span></header><table><thead><tr><th scope="col">Term</th><th scope="col">Meaning in this manual</th></tr></thead><tbody>${terms.map(([term, definition]) => `<tr id="${esc(termId(term))}"><th scope="row">${esc(term)}</th><td>${esc(definition)}</td></tr>`).join('')}</tbody></table></section>`
  })).join('');
}

function glossaryAliasPages() {
  const terms = new Map(glossary.terms.map(([term]) => [term, termId(term)]));
  return page({
    id: 'glossary-aliases', role: 'field-console', route: 'Part VII / Chapter 25', signal: '25.A / alias',
    content: `<section class="console-box"><header><div><p class="component-label">Glossary aliases</p><h1>Alternate terms route to one definition</h1></div><span class="status">Generated routes</span></header><table><thead><tr><th scope="col">Alias or expansion</th><th scope="col">Canonical term</th></tr></thead><tbody>${glossary.aliases.map(([alias, canonical]) => `<tr><th scope="row">${esc(alias)}</th><td><a href="#${esc(terms.get(canonical))}">${esc(canonical)}</a></td></tr>`).join('')}</tbody></table></section>`
  });
}

function legalBackMatterPages() {
  const { license, acknowledgments, support } = fullIndex.backMatter;
  return [
    page({ id: license.id, route: 'Back matter / License', signal: 'L / pinned', className: 'legal-backmatter', content: `<p class="eyebrow">Pinned legal text</p><h1>${esc(license.title)}</h1>${license.paragraphs.slice(0, 4).map((paragraph) => `<p>${esc(paragraph)}</p>`).join('')}<p class="provenance">${esc(license.provenance)}</p>` }),
    page({ id: `${license.id}.continued`, route: 'Back matter / License', signal: 'L.2 / pinned', className: 'legal-backmatter', content: `<p class="eyebrow">License / continued</p><h1>Warranty and liability</h1>${license.paragraphs.slice(4).map((paragraph) => `<p>${esc(paragraph)}</p>`).join('')}<p>Generated authority: <a href="#legal.license"><code>legal.license</code></a>.</p>` }),
    page({ id: acknowledgments.id, route: 'Back matter / Acknowledgments', signal: 'A / disclose', content: `<p class="eyebrow">Rights and provenance</p><h1>${esc(acknowledgments.title)}</h1>${acknowledgments.paragraphs.map((paragraph) => `<p>${esc(paragraph)}</p>`).join('')}<aside class="warning"><p><span class="callout-label">Candidate blocker.</span> Repository-local availability is not a release rights record. The complete rights manifest and locked font profile remain required before a hermetic candidate.</p></aside>` }),
    page({ id: support.id, route: 'Back matter / Support and history', signal: 'S / route', content: `<p class="eyebrow">Offline-first routes</p><h1>${esc(support.title)}</h1>${support.paragraphs.map((paragraph) => `<p>${esc(paragraph)}</p>`).join('')}<ul>${support.links.map(([label, url]) => `<li><a href="${esc(url)}">${esc(label)}</a></li>`).join('')}</ul><p>Offline recovery and escalation remain in <a href="#chapter.troubleshoot">Chapter 18</a> and <a href="#chapter.evidence-escalate">Chapter 19</a>.</p>` })
  ].join('');
}

function fullIndexPages(dataset) {
  const chapters = [memoryKnowledge, conversationsSessionsAgents, toolsFilesArtifacts, codeDocumentKnowledge, connectAgentClient, integrationsExternalData, agentsAutomation, installDeploy, configure, storageHealth, privacySecurity, lifecycle, contributorWorkstation, changeSafely, verifyRelease, troubleshoot, evidenceEscalate, releaseSupport, configurationCatalog, commandsChecks, capabilityCatalog, dataPortability, glossary, fullIndex];
  const entries = [
    ...book.parts.flatMap((part) => part.chapters.map(([id, label]) => ({ id, label, type: 'chapter' }))),
    ...firstRecall.procedures.map((item) => ({ id: item.id, label: item.title, type: 'procedure' })),
    { id: firstRecall.symptom.id, label: firstRecall.symptom.title, type: 'Field Console record' },
    ...signalModel.concepts.map((item) => ({ id: item.id, label: item.title, type: 'concept' })),
    { id: signalModel.checklist.id, label: signalModel.checklist.title, type: 'Field Console checklist' },
    ...chapters.flatMap((chapter) => [
      ...chapter.sections.map((item) => ({ id: item.id, label: item.title, type: 'concept' })),
      ...chapter.procedures.map((item) => ({ id: item.id, label: item.title, type: 'procedure' })),
      ...(chapter.records ?? []).map((item) => ({ id: item.id, label: item.title, type: 'Field Console record' }))
    ]),
    ...glossary.terms.map(([term]) => ({ id: termId(term), label: term, type: 'glossary term' })),
    ...glossary.aliases.map(([alias, canonical]) => ({ id: termId(canonical), label: alias, type: 'glossary alias' })),
    ...Object.values(fullIndex.backMatter).map((item) => ({ id: item.id, label: item.title, type: 'back matter' })),
    ...[...new Set(dataset.rows.map((row) => row.family))].map((family) => ({ id: dataset.rows.find((row) => row.family === family).id, label: `${family} generated catalog`, type: 'fact family' }))
  ].sort((a, b) => a.label.localeCompare(b.label, 'en') || a.id.localeCompare(b.id, 'en'));
  const chunks = [];
  for (let index = 0; index < entries.length; index += 12) chunks.push(entries.slice(index, index + 12));
  return chunks.map((items, index) => page({
    id: index === 0 ? 'full-index-entries' : `full-index-entries.${index + 1}`, role: 'field-console', route: 'Part VII / Chapter 26', signal: `26.${index + 1} / locate`,
    content: `<section class="console-box"><header><div><p class="component-label">Full index${index ? ' / continued' : ''}</p><h1>Offline semantic destinations</h1></div><span class="status">${entries.length} entries</span></header><table><thead><tr><th scope="col">Entry</th><th scope="col">Type</th><th scope="col">Stable destination</th><th scope="col">A4</th><th scope="col">Letter</th></tr></thead><tbody>${items.map((item) => `<tr><th scope="row"><a href="#${esc(item.id)}">${esc(item.label)}</a></th><td>${esc(item.type)}</td><td><code>${esc(item.id)}</code></td><td><span class="index-page" data-target="${esc(item.id)}" data-paper="a4"></span></td><td><span class="index-page" data-target="${esc(item.id)}" data-paper="letter"></span></td></tr>`).join('')}</tbody></table></section>`
  })).join('');
}

function populateIndexPageNumbers(body) {
  const pageStarts = [...body.matchAll(/<section class="manual-page[^"]*" id="[^"]+"/g)].map((match) => match.index);
  const destinations = new Map();
  for (const match of body.matchAll(/\sid="([^"]+)"/g)) {
    let low = 0;
    let high = pageStarts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (pageStarts[middle] <= match.index) low = middle + 1; else high = middle;
    }
    destinations.set(match[1], low);
  }
  return body.replace(/<span class="index-page" data-target="([^"]+)" data-paper="(a4|letter)"><\/span>/g, (_whole, target) => {
    const number = destinations.get(target);
    if (!number) throw new Error(`index destination has no projected page: ${target}`);
    return `<span class="index-page">${number}</span>`;
  });
}

function signalPage() {
  const signal = signalModel.concepts[0];
  const station = ([pin, title, text]) => `<li class="station"><span class="pin" aria-hidden="true">${esc(pin)}</span><h3>${esc(title)}</h3><p>${esc(text)}</p></li>`;
  return page({
    id: 'chapter.signal-model', route: 'Part I / Chapter 2', signal: '11 / trace', number: 12,
    content: `${chapterHead('02', 'Concept', signalModel.title, signalModel.purpose)}<h2 id="${esc(signal.id)}">${esc(signal.title)}</h2><p>${esc(signal.summary)}</p><figure class="diagram-figure"><div class="diagram-shell"><div class="signal-flow"><ol class="station-row" aria-label="Signal stations one through three">${signal.stations.slice(0, 3).map(station).join('')}</ol><svg class="signal-return" viewBox="0 0 1200 120" aria-hidden="true" focusable="false"><defs><linearGradient id="signal-aurora" x1="0" x2="1"><stop stop-color="#7c3aed"/><stop offset=".52" stop-color="#ec4899"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><path d="M1130 5C1100 110 100 110 70 5" fill="none" stroke="url(#signal-aurora)" stroke-width="10" stroke-linecap="round"/></svg><ol class="station-row" start="4" aria-label="Signal stations four through six">${signal.stations.slice(3).map(station).join('')}</ol></div></div><figcaption><span class="caption-number">Figure 2.1.</span> The signal leaves an agent, crosses the tool boundary, reaches storage and retrieval, enters assembled context, and returns as answer plus evidence. The thin aurora return path follows the approved prototype; numbering, labels, and the text lists carry the meaning without color.</figcaption></figure><section class="result success"><p class="component-label">Takeaway</p><p>${esc(signal.takeaway)}</p></section>`
  });
}

function boundaryPage(assets) {
  const item = signalModel.concepts[1];
  return page({
    id: item.id, route: 'Part I / Data boundaries', signal: '12 / separate', number: 13,
    content: `${chapterHead('02A', 'Concept and warning', item.title, item.summary)}<aside class="warning"><p><span class="callout-label">Data boundary.</span> A memory in local storage may later be placed into context for the configured model provider. Local storage does not imply every later inference remains local.</p></aside>${bullets(item.rules)}<section class="mascot-guide" role="note" aria-label="Selective mascot guidance"><img src="${assets.mascotHead}" alt=""><div><p class="guide-label">Aperio says</p><p><span class="em">Trace before tuning.</span> A fluent answer is not recall evidence. Look for successful remember and recall tool results across a fresh conversation.</p></div></section><h2>Portable data is not full protection</h2><p>Portable export/import includes selected data. It is not a full backup and does not establish a full-system recovery path.</p>`
  });
}

function checklistPage() {
  const checklist = signalModel.checklist;
  return page({
    id: checklist.id, role: 'field-console', route: 'Part I / Operator checklist', signal: '13 / inspect', number: 14,
    content: `<section class="console-box"><header><div><p class="component-label">Checklist / matrix</p><h1>${esc(checklist.title)}</h1></div><span class="status">Field Console</span></header><table><thead><tr><th scope="col">Checkpoint</th><th scope="col">Evidence</th><th scope="col">If absent</th></tr></thead><tbody>${checklist.rows.map((cells) => `<tr>${cells.map((cell, index) => index === 0 ? `<th scope="row">${esc(cell)}</th>` : `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></section><p class="provenance">This matrix summarizes evidence. It links back to <a href="#procedure.prove-first-recall">the canonical procedure</a>; it does not duplicate that procedure.</p>`
  });
}

function factsPage(dataset) {
  const chunks = [];
  for (let index = 0; index < dataset.rows.length; index += 2) chunks.push(dataset.rows.slice(index, index + 2));
  return chunks.map((rows, index) => page({
    id: index === 0 ? signalModel.generatedProjection.id : `${signalModel.generatedProjection.id}.${index + 1}`, role: 'field-console', route: 'Generated authority / canonical catalog', signal: `14.${index + 1} / project`,
    content: `<section class="console-box generated-catalog"><header><div><p class="component-label">Generated-fact catalog${index ? ' / continued' : ''}</p><h1>Pinned facts used by authored chapters</h1></div><span class="status">NON-RELEASE</span></header><p>Read-only rows from one normalized dataset. Authored text may interpret and link them but cannot edit or copy them into a shadow catalog.</p><table><thead><tr><th scope="col">Stable ID</th><th scope="col">Pinned fact</th><th scope="col">Evidence</th><th scope="col">Canonical source</th></tr></thead><tbody>${rows.map((fact) => `<tr id="${esc(fact.id)}"><th scope="row"><code>${esc(fact.id)}</code></th><td>${esc(fact.value)}</td><td>${esc(fact.status)}</td><td><code>${esc(fact.source)}</code></td></tr>`).join('')}</tbody></table><p class="provenance">Product ${esc(dataset.provenance.productVersion)} at ${esc(dataset.provenance.productSha)}<br>Generator ${esc(dataset.provenance.generator)}<br>Semantic hash ${esc(dataset.provenance.semanticHash)}</p></section>${index === chunks.length - 1 ? `<p>Commit source: <a href="https://github.com/BaiGanio/aperio/tree/${esc(dataset.provenance.productSha)}">pinned v0.68.0 tree</a>. This external link is supplementary; the catalog is complete offline.</p>` : ''}`
  })).join('');
}

export function reviewChecklistMarkdown() {
  return `# Aperio Manual complete-draft - NON-RELEASE review checklist\n\n- [x] Corrected standalone visual treatment approved for canonical-source integration on 2026-08-13.\n- [ ] Cover is a complete Night Receiver page with the approved mascot and no unintended blank field.\n- [ ] Part openers use Night Receiver; ordinary interiors use Signal Desk; checklists, symptom records, matrices, glossary, index, and generated catalogs use Field Console.\n- [ ] “I want to...”, “Browse by topic”, four role routes, seven parts, and all 26 authored chapters are visible and usable.\n- [ ] Chapters 1-26 and back matter are understandable without color, images, mascot, hover, animation, or network.\n- [ ] No empty or fake reader-facing chapter page exists.\n- [ ] Canonical procedures show orientation, warning, starting state, actions, success, recovery, reversal, and next task.\n- [ ] Platform and interface lanes are shown only at genuine divergence and retain evidence labels.\n- [ ] Diagram, mascot, and v0.68.0-labeled facsimile are nonessential and semantically described.\n- [ ] A4 and Letter pages are readable in color and grayscale with no clipping or collisions.\n- [ ] This packet is reviewed only as NON-RELEASE; no publication, signing, revision, or release identity is approved.\n\n## What follows complete drafting\n\n1. Run the cross-book canonical-ownership and offline editorial pass.\n2. Run whole-book accessibility, link, print, pseudolocale, and release-readiness gates.\n3. Keep signing, upload, publication, and alias movement behind their later explicit human gates.\n`;
}

function reviewPage() {
  const items = reviewChecklistMarkdown().split('\n').filter((line) => line.startsWith('- [ ] ')).map((line) => line.slice(6));
  return page({ id: 'review-checklist', route: 'Review stop', signal: '16 / human gate', number: 16, content: `<p class="eyebrow">Approved integration boundary</p><h1>NON-RELEASE review checklist</h1><ul class="review-list">${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul><h2>What follows integration approval</h2><ol><li>Continue authoring the remaining chapters in sequence; generated catalogs remain evidence inputs, never replacements for explanations or procedures.</li><li>Run whole-book accessibility, link, print, pseudolocale, and release-readiness gates.</li><li>Keep publication behind its later explicit human gate.</li></ol><aside class="warning"><p><span class="callout-label">Stop.</span> Approval authorizes canonical-source integration only. It does not authorize release filenames, checksums, signing, upload, publication, or alias movement.</p></aside><p>Execution epic: <a href="https://github.com/BaiGanio/aperio/issues/405">#405</a>.</p>` });
}

export async function renderHtml({ edition, dataset, assets, pseudo = false }) {
  const title = `${edition.title} - NON-RELEASE`;
  const css = applyFontAssets(visualSystemCss(), assets);
  const procedures = firstRecall.procedures;
  const reference = [releaseSupport, configurationCatalog, commandsChecks, capabilityCatalog, dataPortability]
    .map((chapter) => `${chapterPage(chapter, `Part VII / Chapter ${chapter.number}`, dataset)}${procedure(chapter.procedures[0], `${chapter.number}.1`, `Part VII / Chapter ${chapter.number}`)}`).join('');
  const backMatter = `${chapterPage(glossary, 'Part VII / Chapter 25', dataset)}${glossaryPages()}${glossaryAliasPages()}${procedure(glossary.procedures[0], '25.1', 'Part VII / Chapter 25')}${chapterPage(fullIndex, 'Part VII / Chapter 26', dataset)}${fullIndexPages(dataset)}${procedure(fullIndex.procedures[0], '26.1', 'Part VII / Chapter 26')}${legalBackMatterPages()}`;
  const body = `<a class="skip-link" href="#main-content">Skip to main content</a><header class="screen-banner"><span class="nonrelease-badge">NON-RELEASE</span><span>Aperio Manual / sequential editorial worktree preview</span><span>Not publication</span></header><main id="main-content">${cover(edition, assets)}${navigationPages()}${contentsPage()}${partOpener()}${chapterOneLanding()}${procedure(procedures[0], '01.1')}${procedure(procedures[1], '01.2')}${platformPage(assets)}${procedure(procedures[2], '01.3')}${symptomPage()}${signalPage()}${boundaryPage(assets)}${checklistPage()}${factsPage(dataset)}${usePartOpener()}${chapterPage(memoryKnowledge, 'Part II / Chapter 3', dataset)}${memoryKnowledge.procedures.map((item, index) => procedure(item, `03.${index + 1}`, 'Part II / Chapter 3')).join('')}${chapterPage(conversationsSessionsAgents, 'Part II / Chapter 4', dataset)}${conversationsSessionsAgents.procedures.map((item, index) => procedure(item, `04.${index + 1}`, 'Part II / Chapter 4')).join('')}${chapterPage(toolsFilesArtifacts, 'Part II / Chapter 5', dataset)}${procedure(toolsFilesArtifacts.procedures[0], '05.1', 'Part II / Chapter 5')}${chapterPage(codeDocumentKnowledge, 'Part II / Chapter 6', dataset)}${procedure(codeDocumentKnowledge.procedures[0], '06.1', 'Part II / Chapter 6')}${chapterPage(connectAgentClient, 'Part III / Chapter 7', dataset)}${procedure(connectAgentClient.procedures[0], '07.1', 'Part III / Chapter 7')}${chapterPage(integrationsExternalData, 'Part III / Chapter 8', dataset)}${procedure(integrationsExternalData.procedures[0], '08.1', 'Part III / Chapter 8')}${chapterPage(agentsAutomation, 'Part III / Chapter 9', dataset)}${procedure(agentsAutomation.procedures[0], '09.1', 'Part III / Chapter 9')}${chapterPage(installDeploy, 'Part IV / Chapter 10', dataset)}${procedure(installDeploy.procedures[0], '10.1', 'Part IV / Chapter 10')}${chapterPage(configure, 'Part IV / Chapter 11', dataset)}${procedure(configure.procedures[0], '11.1', 'Part IV / Chapter 11')}${chapterPage(storageHealth, 'Part IV / Chapter 12', dataset)}${procedure(storageHealth.procedures[0], '12.1', 'Part IV / Chapter 12')}${chapterPage(privacySecurity, 'Part IV / Chapter 13', dataset)}${procedure(privacySecurity.procedures[0], '13.1', 'Part IV / Chapter 13')}${chapterPage(lifecycle, 'Part IV / Chapter 14', dataset)}${procedure(lifecycle.procedures[0], '14.1', 'Part IV / Chapter 14')}${chapterPage(contributorWorkstation, 'Part V / Chapter 15', dataset)}${procedure(contributorWorkstation.procedures[0], '15.1', 'Part V / Chapter 15')}${chapterPage(changeSafely, 'Part V / Chapter 16', dataset)}${procedure(changeSafely.procedures[0], '16.1', 'Part V / Chapter 16')}${chapterPage(verifyRelease, 'Part V / Chapter 17', dataset)}${procedure(verifyRelease.procedures[0], '17.1', 'Part V / Chapter 17')}${chapterPage(troubleshoot, 'Part VI / Chapter 18', dataset)}${symptomRecords(troubleshoot, 'Part VI / Chapter 18')}${procedure(troubleshoot.procedures[0], '18.1', 'Part VI / Chapter 18')}${chapterPage(evidenceEscalate, 'Part VI / Chapter 19', dataset)}${symptomRecords(evidenceEscalate, 'Part VI / Chapter 19')}${procedure(evidenceEscalate.procedures[0], '19.1', 'Part VI / Chapter 19')}${reference}${backMatter}${reviewPage()}</main>`;
  const html = `<!doctype html><html lang="en" data-preview="NON-RELEASE" data-paper="screen"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="description" content="NON-RELEASE Aperio Manual sequential editorial worktree preview"><title>${esc(title)}</title><style>${css}</style></head><body>${populateIndexPageNumbers(body)}</body></html>`;
  return pseudo ? pseudolocalizeHtml(html) : html;
}

export function renderC03EditorialReviewHtml({ assets, dataset }) {
  const css = applyFontAssets(visualSystemCss(), assets);
  const intro = page({
    id: 'c03-review',
    route: 'Ticket #430 / editorial checkpoint',
    signal: 'C03 / inspect',
    content: `<p class="eyebrow">Chapters 3–4 only / content review</p><h1>Does this teach a real task?</h1><p class="lede">This bounded preview contains the complete #430 chapter text: concepts, four worked examples, and four canonical procedures. It does not present Chapters 5–26, generated catalogs, or a release candidate for approval.</p><h2>Review standard</h2><ul><li>A named reader and recognizable situation.</li><li>An exact action or tool input.</li><li>An observable result.</li><li>An explanation of why the result matters.</li><li>Failure handling and cleanup.</li></ul><aside class="warning"><p><span class="callout-label">Scope.</span> Approval or rejection here applies only to Chapters 3–4 and the example-driven content model.</p></aside>`
  });
  const chapterThree = `${chapterPage(memoryKnowledge, 'Part II / Chapter 3', dataset)}${memoryKnowledge.procedures.map((item, index) => procedure(item, `03.${index + 1}`, 'Part II / Chapter 3')).join('')}`;
  const chapterFour = `${chapterPage(conversationsSessionsAgents, 'Part II / Chapter 4', dataset)}${conversationsSessionsAgents.procedures.map((item, index) => procedure(item, `04.${index + 1}`, 'Part II / Chapter 4')).join('')}`;
  const body = `<header class="screen-banner"><span class="nonrelease-badge">NON-RELEASE</span><span>Ticket #430 / Chapters 3–4 complete content</span><span>Not publication</span></header><main id="main-content">${intro}${chapterThree}${chapterFour}</main>`;
  return `<!doctype html><html lang="en" data-preview="NON-RELEASE" data-paper="screen"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="description" content="NON-RELEASE Chapters 3–4 editorial review"><title>Aperio Manual Chapters 3–4 — NON-RELEASE</title><style>${css}</style></head><body>${body}</body></html>`;
}

function expand(text) {
  const vowels = { a: 'á', e: 'ë', i: 'ï', o: 'ø', u: 'ü', A: 'Á', E: 'Ë', I: 'Ï', O: 'Ø', U: 'Ü' };
  const transformed = text.replace(/[aeiouAEIOU]/g, (character) => vowels[character]);
  const ratio = text.length <= 10 ? 1 : text.length <= 20 ? .6 : text.length <= 40 ? .4 : text.length <= 80 ? .3 : .2;
  return `⟦${transformed}${'~'.repeat(Math.ceil(text.length * ratio))} Жλ界⟧`;
}

function pseudolocalizeHtml(html) {
  let skipped = false;
  return html.split(/(<[^>]+>)/g).map((token) => {
    if (token.startsWith('<')) {
      if (/^<(style|pre|code)\b/i.test(token)) skipped = true;
      if (/^<\/(style|pre|code)>/i.test(token)) skipped = false;
      return token;
    }
    if (skipped || !/[A-Za-z]/.test(token)) return token;
    return token.split(/(NON-RELEASE|65d45c[0-9a-f]+|v?0\.68\.0|Aperio|(?:procedure|chapter|mcp|support|data|command|interface|asset)\.[A-Za-z0-9:._-]+)/g)
      .map((part) => !part || /^(NON-RELEASE|65d45c|v?0\.68\.0|Aperio|(?:procedure|chapter|mcp|support|data|command|interface|asset)\.)/.test(part) ? part : expand(part))
      .join('');
  }).join('').replace('<html lang="en"', '<html lang="en-x-pseudo"');
}

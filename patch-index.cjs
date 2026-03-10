#!/usr/bin/env node
// Run from your aperio root:  node patch-index.cjs
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'public/index.html');
let html = fs.readFileSync(FILE, 'utf8');
const orig = html;
let changes = 0;

// ── 1. CSS ────────────────────────────────────────────────────────────────────
const CSS = `
    /* ── Reasoning toggle ────────────────────────────────────── */
    .reasoning-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: var(--bg-hover);
      border: 1px solid var(--border);
      border-radius: 20px;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
      cursor: pointer;
      transition: all var(--transition);
      user-select: none;
      letter-spacing: 0.04em;
    }
    .reasoning-toggle:hover { border-color: var(--accent); color: var(--text); }
    .reasoning-toggle.active {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--accent-soft);
    }
    .reasoning-toggle-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--text-muted);
      transition: background var(--transition);
    }
    .reasoning-toggle.active .reasoning-toggle-dot { background: var(--accent); }

    /* ── Reasoning block (collapsible, sits above response) ──── */
    .reasoning-block {
      margin-bottom: 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      overflow: hidden;
      opacity: 0.75;
    }
    .reasoning-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      background: var(--bg-hover);
      cursor: pointer;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
      letter-spacing: 0.06em;
      user-select: none;
      transition: color var(--transition);
    }
    .reasoning-header:hover { color: var(--text); }
    .reasoning-chevron {
      margin-left: auto;
      font-size: 10px;
      transition: transform 180ms ease;
    }
    .reasoning-chevron.open { transform: rotate(90deg); }
    .reasoning-body {
      padding: 8px 12px;
      font-size: 12.5px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      line-height: 1.55;
      background: var(--bg);
      white-space: pre-wrap;
      max-height: 200px;
      overflow-y: auto;
    }
    .reasoning-body.collapsed { display: none; }

    /* Live-streaming bubble styling — dashed border signals "thinking" */
    .message.reasoning-live .bubble {
      opacity: 0.65;
      border-style: dashed;
      font-family: var(--font-mono);
      font-size: 12.5px;
      color: var(--text-muted);
    }
`;

if (!html.includes('reasoning-toggle')) {
  html = html.replace('  </style>', CSS + '\n  </style>');
  changes++;
  console.log('✅ CSS injected');
} else {
  console.log('⏭  CSS already present');
}

// ── 2. Toggle button in header ────────────────────────────────────────────────
const TOGGLE_HTML = `
    <button class="reasoning-toggle" id="reasoningToggle" title="Show/hide model reasoning (Ollama only)">
      <div class="reasoning-toggle-dot"></div>
      reasoning
    </button>`;

// Insert after the closing </div> of theme-switcher, before <!-- Sidebar -->
if (!html.includes('reasoningToggle')) {
  html = html.replace(
    `</div>\n\n  <!-- Sidebar -->`,
    `</div>\n${TOGGLE_HTML}\n\n  <!-- Sidebar -->`
  );
  changes++;
  console.log('✅ Toggle button injected');
} else {
  console.log('⏭  Toggle button already present');
}

// ── 3. JS — add reasoning state + helpers BEFORE the connect() call ───────────
const REASONING_STATE_JS = `
// ── Reasoning feature ────────────────────────────────────────────────────────
let showReasoning = localStorage.getItem('aperio-reasoning') !== 'false'; // default ON

function applyReasoningToggle() {
  const btn = document.getElementById('reasoningToggle');
  if (!btn) return;
  btn.classList.toggle('active', showReasoning);
  btn.title = showReasoning
    ? 'Reasoning visible — click to hide'
    : 'Reasoning hidden — click to show';
}

document.getElementById('reasoningToggle')?.addEventListener('click', () => {
  showReasoning = !showReasoning;
  localStorage.setItem('aperio-reasoning', showReasoning);
  applyReasoningToggle();
});

applyReasoningToggle();

function escHtml(t) {
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function addReasoningBlock(bubble, text) {
  if (!text || !text.trim()) return;
  const block = document.createElement('div');
  block.className = 'reasoning-block';
  block.innerHTML =
    '<div class="reasoning-header" onclick="' +
      'var b=this.nextElementSibling;' +
      'b.classList.toggle(\\'collapsed\\');' +
      'this.querySelector(\\'.reasoning-chevron\\').classList.toggle(\\'open\\')' +
    '">' +
      '<span>◎ reasoning</span>' +
      '<span class="reasoning-chevron open">›</span>' +
    '</div>' +
    '<div class="reasoning-body">' + escHtml(text) + '</div>';
  bubble.insertBefore(block, bubble.firstChild);
}
`;

if (!html.includes('showReasoning')) {
  // Insert right before the connect() call
  html = html.replace('// ── WebSocket', REASONING_STATE_JS + '\n// ── WebSocket');
  changes++;
  console.log('✅ Reasoning state JS injected');
} else {
  console.log('⏭  Reasoning state JS already present');
}

// ── 4. Add retract handler INSIDE existing handleMessage ─────────────────────
// Find the stream_start case and insert retract BEFORE it — no wrapping, no recursion
const RETRACT_CASE = `
  if (msg.type === "retract") {
    // Remove last AI bubble or convert it to a reasoning block
    const lastAI = [...messagesEl.querySelectorAll('.message.ai')].at(-1);
    if (lastAI) {
      if (showReasoning && msg.reasoning) {
        lastAI.classList.remove('reasoning-live');
        const bubble = lastAI.querySelector('.bubble');
        if (bubble) {
          bubble.innerHTML = '';
          addReasoningBlock(bubble, msg.reasoning);
          // Placeholder where real response will stream into
          const responseArea = document.createElement('div');
          responseArea.className = 'reasoning-response';
          bubble.appendChild(responseArea);
          lastAI.dataset.awaitingResponse = '1';
        }
      } else {
        lastAI.remove();
      }
    }
    streamingBubble = null;
    streamingText = '';
    return;
  }

`;

if (!html.includes('msg.type === "retract"')) {
  // Insert right before the stream_start handler
  html = html.replace(
    '  if (msg.type === "stream_start")',
    RETRACT_CASE + '  if (msg.type === "stream_start")'
  );
  changes++;
  console.log('✅ retract handler injected');
} else {
  console.log('⏭  retract handler already present');
}

// ── 5. Mark live-streaming bubbles + handle awaitingResponse in stream_start ──
// After the streaming bubble is created, add .reasoning-live class
// Also handle the case where we're continuing after a reasoning block
const STREAM_START_PATCH = `
    // If previous message is awaiting a response (has reasoning block), reuse it
    const awaitingMsg = messagesEl.querySelector('.message.ai[data-awaitingResponse="1"]');
    if (awaitingMsg) {
      delete awaitingMsg.dataset.awaitingResponse;
      streamingBubble = awaitingMsg.querySelector('.reasoning-response') || awaitingMsg.querySelector('.bubble');
      streamingText = '';
      setStatus('thinking', 'responding…');
    } else {
`;

// We need to find the stream_start block and add the awaiting check
// Look for where streamingBubble is first assigned in stream_start
if (!html.includes('awaitingResponse')) {
  // Find the stream_start handler and patch in the awaiting check
  // The pattern is: if (msg.type === "stream_start") { ... removeThinking(); ... addMessage
  html = html.replace(
    `  if (msg.type === "stream_start") {`,
    `  if (msg.type === "stream_start") {\n    // Mark as live-reasoning stream\n    setTimeout(() => {\n      const lastAI = [...messagesEl.querySelectorAll('.message.ai')].at(-1);\n      if (lastAI && streamingBubble) lastAI.classList.add('reasoning-live');\n    }, 0);\n`
  );
  changes++;
  console.log('✅ reasoning-live class patch applied');
} else {
  console.log('⏭  reasoning-live patch already present');
}

// ── Save ──────────────────────────────────────────────────────────────────────
if (changes > 0) {
  fs.writeFileSync(FILE, html, 'utf8');
  console.log(`\n✅ ${changes} patch(es) applied to public/index.html`);
} else {
  console.log('\n✅ Nothing to do — already up to date');
}

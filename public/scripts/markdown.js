function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Weak local models often emit raw LaTeX (\( … \), \[ … \], \boxed{…}, \frac{…})
// which we don't typeset. Rather than leak backslashes into the chat, fold the
// common constructs down to clean, readable plain text. Runs on prose only —
// code blocks are already extracted to placeholders before this is called, and
// `$…$` is left alone so currency isn't mangled.
function normalizeMath(text) {
  return text
    // display math \[ … \] → its own lines; inline \( … \) → inline
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_, m) => `\n${m.trim()}\n`)
    .replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_, m) => m.trim())
    // \boxed{X} → bold; \text{X}/\mathrm{X} → contents
    .replace(/\\boxed\s*\{([^{}]*)\}/g, (_, m) => `**${m.trim()}**`)
    .replace(/\\(?:text|mathrm|mathbf|textbf|textit|mathit)\s*\{([^{}]*)\}/g, (_, m) => m)
    // \frac{a}{b} / \dfrac{a}{b} → a/b
    .replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => `${a.trim()}/${b.trim()}`)
    // sizing / layout commands that carry no text → drop
    .replace(/\\(?:left|right|big|bigg|Big|Bigg|displaystyle|quad|qquad)\b/g, "")
    // common symbol commands
    .replace(/\\times\b/g, "×")
    .replace(/\\cdot\b/g, "·")
    .replace(/\\div\b/g, "÷")
    .replace(/\\pm\b/g, "±")
    .replace(/\\leq?\b/g, "≤")
    .replace(/\\geq?\b/g, "≥")
    .replace(/\\neq\b/g, "≠")
    .replace(/\\approx\b/g, "≈")
    .replace(/\\rightarrow\b/g, "→")
    .replace(/\\to\b/g, "→")
    // thin / negative spaces
    .replace(/\\[,!;:]/g, " ")
    // any leftover \command → keep the word, drop the backslash
    .replace(/\\([a-zA-Z]+)/g, "$1")
    // stray escaped math delimiters left behind
    .replace(/\\([{}[\]()])/g, "$1");
}

// Mermaid's flowchart parser cannot read a bracket or a pipe inside a BARE node
// label: `C[Message Queue (e.g., RabbitMQ/SQS)]` is a parse error, not a
// diagram — and models write exactly that shape constantly, so a whole plan
// arrived with its architecture diagram showing as raw source. Quoting the
// label fixes every one of those characters; ( ) [ ] { } | were measured
// against mermaid 11 in a browser, and all six parse once quoted.
const _LABEL_BREAKERS = /[()[\]{}|]/;
// `[(cylinder)]`, `((circle))`, `{{hexagon}}` are SHAPES, not labels that need
// quoting — quoting one would flatten it back to a plain box.
const _SHAPE_WRAPPED = /^\s*(?:\(.*\)|\[.*\]|\{.*\})\s*$/;

function _quoteMermaidLabels(source) {
  const first = String(source).split("\n").find(line => line.trim()) || "";
  // Only flowcharts use this node syntax. A sequence or class diagram has its
  // own grammar, where the same brackets mean something else.
  if (!/^\s*(?:flowchart|graph)\b/i.test(first)) return source;
  let out = String(source);
  for (const [open, close] of [["[", "]"], ["(", ")"], ["{", "}"]]) {
    const re = new RegExp(`([A-Za-z0-9_]+)\\${open}([^\\n]*?)\\${close}(?=$|[\\s;])`, "gm");
    out = out.replace(re, (full, id, label) => {
      if (!_LABEL_BREAKERS.test(label)) return full;
      if (/^".*"$/.test(label.trim()) || _SHAPE_WRAPPED.test(label)) return full;
      return `${id}${open}"${label.replace(/"/g, "&quot;")}"${close}`;
    });
  }
  return out;
}

// Some models call PlantUML's component dialect "Mermaid". Mermaid has no
// componentDiagram type, so repair that narrow, unambiguous shape first.
function normalizeMermaidSource(source) {
  const lines = String(source).replace(/\r/g, "").split("\n");
  if (lines[0]?.trim().toLowerCase() !== "componentdiagram") return _quoteMermaidLabels(String(source));
  const out = ["flowchart TD"];
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "}") { out.push("end"); continue; }
    const packageMatch = trimmed.match(/^package\s+"([^"]+)"\s*\{$/i);
    if (packageMatch) {
      const id = packageMatch[1].replace(/[^a-zA-Z0-9_]/g, "") || "Subsystems";
      out.push(`subgraph ${id}["${packageMatch[1].replace(/\"/g, "'")}"]`);
      continue;
    }
    const componentMatch = trimmed.match(/^component\s+"([^"]+)"\s+as\s+([a-zA-Z0-9_]+)$/i);
    if (componentMatch) {
      out.push(`${componentMatch[2]}["${componentMatch[1].replace(/\"/g, "'")}"]`);
      continue;
    }
    const databaseMatch = trimmed.match(/^database\s+"([^"]+)"\s+as\s+([a-zA-Z0-9_]+)$/i);
    if (databaseMatch) {
      out.push(`${databaseMatch[2]}[("${databaseMatch[1].replace(/\"/g, "'")}")]`);
      continue;
    }
    const edgeMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s+(<-->|-->|<--|---)\s+(?:"([^"]+)"|([a-zA-Z0-9_]+))(?:\s*:\s*(.+))?$/);
    if (edgeMatch) {
      const target = edgeMatch[4] || `${edgeMatch[3].replace(/[^a-zA-Z0-9_]/g, "") || "Node"}["${edgeMatch[3].replace(/\"/g, "'")}"]`;
      const label = edgeMatch[5] ? `|${edgeMatch[5].replace(/[|\"<>]/g, "")} |` : "";
      out.push(`${edgeMatch[1]} ${edgeMatch[2]}${label} ${target}`);
      continue;
    }
    out.push(`%% ${trimmed}`);
  }
  return _quoteMermaidLabels(out.join("\n"));
}

// A streaming answer rebuilds its bubble on every frame, so a diagram already
// on screen arrives as a BRAND NEW node ~30 times a second — and each one was
// drawn from scratch, which is the flicker. Keep the drawn SVG keyed by its
// source: an unchanged diagram is re-attached instantly instead of redrawn.
// Bounded, oldest-out, so a long session cannot grow it without limit.
const _mermaidSvgCache = new Map();
const _MERMAID_CACHE_MAX = 50;

function _rememberMermaidSvg(source, svg) {
  if (!source || !svg) return;
  _mermaidSvgCache.delete(source);            // re-insert to mark it newest
  _mermaidSvgCache.set(source, svg);
  while (_mermaidSvgCache.size > _MERMAID_CACHE_MAX) {
    _mermaidSvgCache.delete(_mermaidSvgCache.keys().next().value);
  }
}

function scheduleMermaidRender() {
  if (!window.mermaid || scheduleMermaidRender.queued) return;
  if (!scheduleMermaidRender.initialized) {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base" });
    scheduleMermaidRender.initialized = true;
  }
  scheduleMermaidRender.queued = true;
  queueMicrotask(async () => {
    scheduleMermaidRender.queued = false;
    const fresh = [...document.querySelectorAll(".mermaid:not([data-mermaid-rendered])")];
    if (!fresh.length) return;

    // Re-attach what has already been drawn — synchronously, in this frame, so
    // the diagram never blanks between the node appearing and mermaid running.
    const nodes = [];
    for (const node of fresh) {
      const cached = _mermaidSvgCache.get(node.dataset.mermaidSource || "");
      if (cached) {
        node.innerHTML = cached;
        node.dataset.mermaidRendered = "cached";
      } else {
        nodes.push(node);
      }
    }
    if (!nodes.length) return;

    nodes.forEach(node => { node.dataset.mermaidRendered = "pending"; });
    try {
      await window.mermaid.run({ nodes });
      nodes.forEach(node => {
        if (node.dataset.mermaidRendered === "pending") node.dataset.mermaidRendered = "done";
        _rememberMermaidSvg(node.dataset.mermaidSource || "", node.innerHTML);
      });
    } catch (err) {
      nodes.forEach(node => {
        if (node.dataset.mermaidRendered === "pending") {
          node.dataset.mermaidRendered = "error";
          node.classList.add("mermaid-error");
          node.textContent = node.dataset.mermaidSource || node.textContent;
        }
      });
      console.warn("Mermaid diagram could not be rendered", err);
    }
  });
}

// CommonMark fence rules, plus one repair for a shape models emit constantly.
//
// A fence opened with N backticks is closed only by a line of N-or-more
// backticks and nothing else; a line carrying an info string ("```mermaid")
// opens a block, it never closes one. The old single regex honoured neither
// rule, so a document fenced as ```markdown that contained its own ```mermaid
// block was cut at the inner fence — the diagram leaked out as bare prose and
// the tail reopened as an unlabelled "code" block.
//
// Models also nest same-width fences (``` inside ```markdown) where CommonMark
// wants a wider outer fence. Inside a markdown/md container we therefore track
// nesting depth, so the inner pair stays content and the outer block ends at
// the last fence.
const FENCE_LINE = /^ {0,3}(`{3,})[ \t]*(.*?)[ \t]*$/;

function matchFence(line) {
  const m = FENCE_LINE.exec(String(line).replace(/\r$/, ""));
  // An info string may not contain a backtick.
  if (!m || m[2].includes("`")) return null;
  return { ticks: m[1].length, info: m[2] };
}

// Split text into an ordered run of parts, each covering a whole number of
// source lines: { fence: false, value } for prose, { fence: true, lang, code,
// raw } for a fenced block. Joining every part's text with "\n" reproduces the
// input exactly, so callers can rewrite only the parts they care about.
// Shared by renderMarkdown() and the deliverable stripper, which must agree on
// where a block starts and ends or the chat hides a different span than the
// server saved to disk. lib/agent/deliverables.js mirrors this on the server.
function scanFences(text) {
  const lines = String(text).split("\n");
  const parts = [];
  let prose = [];
  const flush = () => {
    if (prose.length) { parts.push({ fence: false, value: prose.join("\n") }); prose = []; }
  };
  for (let i = 0; i < lines.length; i++) {
    const open = matchFence(lines[i]);
    if (!open) { prose.push(lines[i]); continue; }
    flush();
    const lang = open.info.split(/\s+/)[0] || "";
    const container = /^(?:markdown|md)$/i.test(lang);
    let depth = 1;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const f = matchFence(lines[j]);
      if (!f) continue;
      if (!f.info && f.ticks >= open.ticks) {
        if (--depth === 0) { close = j; break; }
      } else if (container && f.info) {
        depth++;
      }
    }
    // A fence the model opened but never closed (weak models get cut off
    // mid-build) takes the rest of the text, so it is still treated as one
    // real block instead of leaking as a flat wall of escaped source.
    const end = close === -1 ? lines.length : close;
    parts.push({
      fence: true,
      closed: close !== -1,
      lang,
      code: lines.slice(i + 1, end).join("\n"),
      raw: lines.slice(i, close === -1 ? lines.length : close + 1).join("\n"),
    });
    i = end;
  }
  flush();
  return parts;
}

// `depth` guards the markdown-in-markdown recursion below; callers pass nothing.
function renderMarkdown(text, depth = 0) {
  const blocks = [];

  function pushBlock(lang, code, closed) {
    const safeLang = /^[a-zA-Z0-9_+-]+$/.test(lang) ? lang : "";
    // A ```markdown fence is a DOCUMENT, not source code. Models wrap a plan or
    // a report in one out of habit, and showing it as a code box meant the
    // headings stayed as `#`, the lists as `*`, and — the part that kept being
    // reported — the ```mermaid diagram inside it never got drawn. Render it,
    // so the diagram inside becomes a real diagram.
    if ((safeLang.toLowerCase() === "markdown" || safeLang.toLowerCase() === "md") && depth < 2) {
      blocks.push('<div class="md-doc">' + renderMarkdown(code, depth + 1) + '</div>');
      return "\x00" + (blocks.length - 1) + "\x00";
    }
    if (safeLang.toLowerCase() === "mermaid") {
      const diagram = normalizeMermaidSource(code.trim());
      if (closed === false) {
        // Half a diagram cannot parse. Drawing it anyway throws, paints an
        // error, and the next frame replaces that with another error — so hold
        // the source as plain text until its closing fence lands, then draw
        // once. This is the other half of the streaming flicker.
        blocks.push(
          '<div class="mermaid-block mermaid-block--pending">' +
          '<pre class="mermaid-pending">' + escapeHtml(diagram) + '</pre></div>'
        );
        return "\x00" + (blocks.length - 1) + "\x00";
      }
      // A diagram already drawn is emitted as its finished SVG, so it is present
      // in the very first paint of this frame. Waiting for the scheduler to
      // swap it in meant every frame briefly held the raw source in a
      // differently-sized box, and the diagram re-derived itself all the way
      // down the answer.
      const drawn = _mermaidSvgCache.get(diagram);
      blocks.push(
        '<div class="mermaid-block"><div class="mermaid" data-mermaid-source="' +
        escapeHtml(diagram) + '"' + (drawn ? ' data-mermaid-rendered="cached"' : '') + '>' +
        (drawn || escapeHtml(diagram)) + '</div>' +
        '<details><summary>Mermaid source</summary><pre><code>' +
        escapeHtml(diagram) + '</code></pre></details></div>'
      );
      return "\x00" + (blocks.length - 1) + "\x00";
    }
    const id = "cb-" + Math.random().toString(36).slice(2, 8);
    const label = escapeHtml(lang || "code");
    const langClass = safeLang ? ' class="language-' + escapeHtml(safeLang) + '"' : "";
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    blocks.push(
      '<div class="code-block">' +
      '<div class="code-toolbar"><span class="code-lang">' + label + '</span>' +
      '<button class="copy-btn" data-action="copyCode" data-code-id="' + id + '">' +
      '<i class="bi bi-clipboard"></i> copy</button></div>' +
      '<pre><code id="' + id + '"' + langClass + '>' + escaped.trimEnd() + '</code></pre></div>'
    );
    return "\x00" + (blocks.length - 1) + "\x00";
  }

  text = scanFences(text)
    .map(part => (part.fence ? pushBlock(part.lang, part.code, part.closed) : part.value))
    .join("\n");

  text = normalizeMath(text);

  text = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    // Allow single `*` (nested italics) inside bold; restrict to one line so a
    // stray `**` can't span the whole message.
    .replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^\n*]+?)\*(?!\*)/g, "<em>$1</em>")
    // Inline images: ![alt](src). src is allowlisted to local generated-file
    // routes and https to keep the innerHTML injection safe (no javascript:/data:).
    .replace(/!\[([^\]]*)\]\((\/(?:scratch|uploads)\/[^)\s]+|https:\/\/[^)\s]+)\)/g,
      (_, alt, src) => `<img class="chat-image" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">`)
    // A `"` inside the URL would otherwise close the href attribute and let the
    // rest of the match inject arbitrary HTML attributes (an inline event
    // handler, say) into the anchor this innerHTML builds. Only the quote needs
    // escaping here — `&`, `<` and `>` were already escaped at the top of this
    // chain, so a full escapeHtml() pass would double-encode the `&` in a query
    // string and break the link.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      (_, label, href) => `<a href="${href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">${label}</a>`);

  const lines = text.split("\n");
  const output = [];
  let listItems = [];
  let listType = null;

  function flushList() {
    if (!listItems.length) return;
    output.push(`<${listType}>${listItems.map(li => `<li>${li}</li>`).join("")}</${listType}>`);
    listItems = [];
    listType = null;
  }

  for (const line of lines) {
    const hMatch = line.match(/^(#{1,6}) (.+)$/);
    if (hMatch) {
      flushList();
      output.push(`<h${hMatch[1].length}>${hMatch[2]}</h${hMatch[1].length}>`);
      continue;
    }
    const ulMatch = line.match(/^[-*+] (.+)$/);
    if (ulMatch) {
      if (listType === "ol") flushList();
      listType = "ul";
      listItems.push(ulMatch[1]);
      continue;
    }
    const olMatch = line.match(/^\d+\. (.+)$/);
    if (olMatch) {
      if (listType === "ul") flushList();
      listType = "ol";
      listItems.push(olMatch[1]);
      continue;
    }
    flushList();
    output.push(line);
  }
  flushList();

  // ── Table parsing ──
  // Converts markdown pipe tables to HTML <table>.
  // Detects: header row (starts with |), separator row (| --- |), data rows.
  // Inline formatting (bold, code, links) is already applied at this point.
  const tableOutput = [];
  let i = 0;
  while (i < output.length) {
    const line = output[i];

    if (typeof line === 'string' && line.trim().startsWith('|') && i + 2 <= output.length) {
      const sepLine = output[i + 1];
      const isSep = typeof sepLine === 'string' && /^\|[\s\-:|]+\|$/.test(sepLine.trim());

      if (isSep) {
        // Gather all table rows (header + sep + data)
        const rows = [];
        let j = i;
        while (j < output.length && typeof output[j] === 'string' && output[j].trim().startsWith('|')) {
          rows.push(output[j]);
          j++;
        }

        if (rows.length >= 3) {
          // Split row into cells, discarding the empty first/last entries from split.
          // Models commonly emit a literal <br> to break lines within a cell; by now
          // it's been HTML-escaped to &lt;br&gt;, so fold the safe variants back to a
          // real <br> (nothing else is un-escaped, keeping the injection surface closed).
          const parseCells = (row) => row.split('|').slice(1, -1)
            .map(c => c.trim().replace(/&lt;br\s*\/?&gt;/gi, '<br>'));

          const headerCells = parseCells(rows[0]).map(c => `<th>${c}</th>`).join('');
          const thead = `<thead><tr>${headerCells}</tr></thead>`;

          const bodyRows = [];
          for (let k = 2; k < rows.length; k++) {
            const cells = parseCells(rows[k]).map(c => `<td>${c}</td>`).join('');
            bodyRows.push(`<tr>${cells}</tr>`);
          }
          const tbody = `<tbody>${bodyRows.join('')}</tbody>`;

          tableOutput.push(`<table>${thead}${tbody}</table>`);
          i = j;
          continue;
        }
      }
    }

    tableOutput.push(line);
    i++;
  }

  text = tableOutput.join("\n")
    .replace(/\n/g, "<br>")
    .replace(/<br>(<(?:div|[uo]l|h[1-6]|table|thead|tbody|tr)\b)/g, "$1")
    .replace(/(<\/(?:[uo]l|h[1-6]|div|table|thead|tbody|tr)>)<br>/g, "$1");

  text = text.replace(/\x00(\d+)\x00/g, (_, i) => blocks[Number.parseInt(i)]);
  scheduleMermaidRender();
  return text;
}

window.addEventListener("load", scheduleMermaidRender);

// Prism.highlightAll() walks the WHOLE document and re-tokenizes every code
// block in every earlier message. During streaming it is called once per frame,
// so its cost tracks the length of the entire conversation rather than the size
// of the message being written — the older the chat, the heavier every frame.
// Callers that know which bubble changed pass it, and pay for that bubble only.
function highlightAll(root) {
  if (!window.Prism) return;
  if (root) Prism.highlightAllUnder(root);
  else Prism.highlightAll();
}

function copyCode(id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.innerText).then(() => {
    const btn = el.closest(".code-block")?.querySelector(".copy-btn");
    if (!btn) return;
    btn.innerHTML = '<i class="bi bi-clipboard-check"></i> copied!';
    btn.classList.add("copied");
    setTimeout(() => {
      btn.innerHTML = '<i class="bi bi-clipboard"></i> copy';
      btn.classList.remove("copied");
    }, 2000);
  });
}

function copyBubble(btn) {
  const raw = btn.dataset.raw || btn.closest(".bubble")?.dataset?.raw;
  if (!raw) return;
  navigator.clipboard.writeText(raw).then(() => {
    btn.innerHTML = '<i class="bi bi-clipboard-check"></i>';
    btn.classList.add("copied");
    setTimeout(() => {
      btn.innerHTML = '<i class="bi bi-clipboard"></i>';
      btn.classList.remove("copied");
    }, 2000);
  });
}

function _attachBubbleCopyBtn(bubble, rawText) {
  bubble.dataset.raw = rawText;
  const btn = document.createElement("button");
  btn.className = "bubble-copy-btn";
  btn.title = "Copy";
  btn.innerHTML = '<i class="bi bi-clipboard"></i>';
  btn.onclick = () => copyBubble(btn);
  bubble.appendChild(btn);
}

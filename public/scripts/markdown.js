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

// Some models call PlantUML's component dialect "Mermaid". Mermaid has no
// componentDiagram type, so repair that narrow, unambiguous shape first.
function normalizeMermaidSource(source) {
  const lines = String(source).replace(/\r/g, "").split("\n");
  if (lines[0]?.trim().toLowerCase() !== "componentdiagram") return String(source);
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
  return out.join("\n");
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
    const nodes = [...document.querySelectorAll(".mermaid:not([data-mermaid-rendered])")];
    if (!nodes.length) return;
    nodes.forEach(node => { node.dataset.mermaidRendered = "pending"; });
    try {
      await window.mermaid.run({ nodes });
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

function renderMarkdown(text) {
  const blocks = [];
  // A model that opened a ``` code fence but never closed it (common with weak
  // models that get cut off mid-build) would otherwise have the whole block
  // escaped into a flat wall of text — no .code-block element, so it can't be
  // collapsed and floods the message. Close a dangling fence so the remainder
  // renders as a real, collapsible code block.
  if (((text.match(/```/g) || []).length) % 2 === 1) text += "\n```";
  text = text.replace(/```(\w*)[ \t]*\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = "cb-" + Math.random().toString(36).slice(2, 8);
    const label = escapeHtml(lang || "code");
    const safeLang = /^[a-zA-Z0-9_+-]+$/.test(lang) ? lang : "";
    const langClass = safeLang ? ' class="language-' + escapeHtml(safeLang) + '"' : "";
    if (safeLang.toLowerCase() === "mermaid") {
      const diagram = normalizeMermaidSource(code.trim());
      blocks.push(
        '<div class="mermaid-block"><div class="mermaid" data-mermaid-source="' +
        escapeHtml(diagram) + '">' + escapeHtml(diagram) + '</div>' +
        '<details><summary>Mermaid source</summary><pre><code>' +
        escapeHtml(diagram) + '</code></pre></details></div>'
      );
      return "\x00" + (blocks.length - 1) + "\x00";
    }
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const idx = blocks.length;
    blocks.push(
      '<div class="code-block">' +
      '<div class="code-toolbar"><span class="code-lang">' + label + '</span>' +
      '<button class="copy-btn" data-action="copyCode" data-code-id="' + id + '">' +
      '<i class="bi bi-clipboard"></i> copy</button></div>' +
      '<pre><code id="' + id + '"' + langClass + '>' + escaped.trimEnd() + '</code></pre></div>'
    );
    return "\x00" + idx + "\x00";
  });

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

function highlightAll() {
  if (window.Prism) Prism.highlightAll();
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

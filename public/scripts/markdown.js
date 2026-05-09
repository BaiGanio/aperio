function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMarkdown(text) {
  const blocks = [];
  text = text.replace(/```(\w*)[ \t]*\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = "cb-" + Math.random().toString(36).slice(2, 8);
    const label = lang || "code";
    const langClass = lang ? ' class="language-' + lang + '"' : "";
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const idx = blocks.length;
    blocks.push(
      '<div class="code-block">' +
      '<div class="code-toolbar"><span class="code-lang">' + label + '</span>' +
      '<button class="copy-btn" onclick="copyCode(\'' + id + '\')">' +
      '<i class="bi bi-clipboard"></i> copy</button></div>' +
      '<pre><code id="' + id + '"' + langClass + '>' + escaped.trimEnd() + '</code></pre></div>'
    );
    return "\x00" + idx + "\x00";
  });

  text = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^\n*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^\n*]+?)\*(?!\*)/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

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
          // Split row into cells, discarding the empty first/last entries from split
          const parseCells = (row) => row.split('|').slice(1, -1).map(c => c.trim());

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
  return text;
}

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

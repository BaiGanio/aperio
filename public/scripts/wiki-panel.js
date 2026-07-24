// public/scripts/wiki-panel.js
// Read-only browser for wiki articles. Slide-in panel from the right.
// Renders list / search results / one-article detail in a single container.

(() => {
  const panel    = () => document.getElementById("wiki-panel");
  const backdrop = () => document.getElementById("wiki-backdrop");
  const body     = () => document.getElementById("wiki-panel-body");
  const toolbar  = () => document.getElementById("wiki-panel-toolbar");
  const input    = () => document.getElementById("wikiSearchInput");

  let currentStatus = "all"; // matches the chip set
  let searchTimer   = null;
  let lastQuery     = "";

  // Tag-derived "sections" for the grouped sidebar. An article lands in the
  // first section whose tag it carries; anything that matches none falls into
  // "Other". Order here is the order shown in the panel.
  const SECTIONS = [
    { id: "philosophy",    label: "Philosophy",     tag: "philosophy",    icon: "bi-lightbulb"     },
    { id: "architecture",  label: "Architecture",   tag: "architecture",  icon: "bi-diagram-3"     },
    { id: "memory",        label: "Memory",         tag: "memory",        icon: "bi-cpu"           },
    { id: "wiki",          label: "Wiki",           tag: "wiki",          icon: "bi-book"          },
    { id: "providers",     label: "Providers",      tag: "providers",     icon: "bi-plug"          },
    { id: "tools",         label: "MCP Tools",      tag: "mcp",           icon: "bi-tools"         },
    { id: "skills",        label: "Skills",         tag: "skills",        icon: "bi-stars"         },
    { id: "embeddings",    label: "Embeddings",     tag: "embeddings",    icon: "bi-bounding-box"  },
  ];
  const OTHER_SECTION = { id: "other", label: "Other", icon: "bi-three-dots" };

  // Persist expanded/collapsed state across panel opens. Default: all sections
  // collapsed — the sidebar opens as a clean table of contents, and the user
  // expands the sections they care about.
  const collapsedKey = "aperio.wiki.collapsedSections";
  const stored = localStorage.getItem(collapsedKey);
  const allSectionIds = () => [...SECTIONS.map(s => s.id), OTHER_SECTION.id];
  const collapsed = new Set(stored === null ? allSectionIds() : JSON.parse(stored));
  function persistCollapsed() {
    localStorage.setItem(collapsedKey, JSON.stringify([...collapsed]));
  }

  function sectionFor(article) {
    const tags = article.tags || [];
    for (const s of SECTIONS) {
      if (tags.includes(s.tag)) return s;
    }
    return OTHER_SECTION;
  }

  function groupArticles(articles) {
    const buckets = new Map();
    for (const s of [...SECTIONS, OTHER_SECTION]) buckets.set(s.id, { section: s, items: [] });
    for (const a of articles) buckets.get(sectionFor(a).id).items.push(a);
    return [...buckets.values()].filter(b => b.items.length > 0);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  const fmtDate = ts => new Date(ts).toISOString().slice(0, 10);

  function statusBadge(status) {
    return `<span class="wiki-status wiki-status--${escapeHtml(status)}">${escapeHtml(status)}</span>`;
  }

  function articleCard(a) {
    const tags = (a.tags || []).map(t => `<span class="wiki-card-tag">#${escapeHtml(t)}</span>`).join(" ");
    const summary = a.summary ? `<div class="wiki-card-summary">${escapeHtml(a.summary)}</div>` : "";
    return `
      <div class="wiki-card" data-slug="${escapeHtml(a.slug)}">
        <div class="wiki-card-title">${escapeHtml(a.title)} ${statusBadge(a.status)}</div>
        ${summary}
        <div class="wiki-card-meta">
          <span>[[${escapeHtml(a.slug)}]]</span>
          <span>rev ${a.revision}</span>
          <span>${fmtDate(a.generated_at)}</span>
          ${tags}
        </div>
      </div>`;
  }

  async function fetchList() {
    const params = new URLSearchParams();
    if (currentStatus !== "all") params.set("status", currentStatus);
    const r = await fetch(`/api/wiki/list?${params}`);
    if (!r.ok) throw new Error(`list ${r.status}`);
    const { articles } = await r.json();
    return articles;
  }

  async function fetchSearch(q) {
    const params = new URLSearchParams({ q });
    if (currentStatus !== "all") params.set("status", currentStatus);
    const r = await fetch(`/api/wiki/search?${params}`);
    if (!r.ok) throw new Error(`search ${r.status}`);
    const { articles } = await r.json();
    return articles;
  }

  async function fetchArticle(slug) {
    const r = await fetch(`/api/wiki/article/${encodeURIComponent(slug)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`article ${r.status}`);
    return await r.json();
  }

  function renderList(articles) {
    toolbar().style.display = "";
    if (!articles.length) {
      body().innerHTML = `<div class="wiki-empty">No articles yet. Ask the AI to write one.</div>`;
      return;
    }
    // When the user is actively searching, the grouped tree gets in the way —
    // show a flat list so ranked results stay visible.
    if (lastQuery) {
      body().innerHTML = articles.map(articleCard).join("");
    } else {
      const groups = groupArticles(articles);
      body().innerHTML = groups.map(({ section, items }) => {
        const isCollapsed = collapsed.has(section.id);
        const cards = items.map(articleCard).join("");
        return `
          <div class="wiki-group ${isCollapsed ? "wiki-group--collapsed" : ""}" data-section="${escapeHtml(section.id)}">
            <button class="wiki-group-header" type="button">
              <i class="bi ${escapeHtml(section.icon)} wiki-group-icon"></i>
              <span class="wiki-group-label">${escapeHtml(section.label)}</span>
              <span class="wiki-group-count">${items.length}</span>
              <i class="bi bi-chevron-down wiki-group-chevron"></i>
            </button>
            <div class="wiki-group-body">${cards}</div>
          </div>`;
      }).join("");
      body().querySelectorAll(".wiki-group-header").forEach(h => {
        h.addEventListener("click", () => {
          const group = h.parentElement;
          const id = group.dataset.section;
          group.classList.toggle("wiki-group--collapsed");
          if (group.classList.contains("wiki-group--collapsed")) collapsed.add(id);
          else collapsed.delete(id);
          persistCollapsed();
        });
      });
    }
    body().querySelectorAll(".wiki-card").forEach(card => {
      card.addEventListener("click", () => openArticle(card.dataset.slug));
    });
  }

  // Convert [[slug]] and [[mem:uuid]] markers in body_md into anchors.
  // Done AFTER renderMarkdown — so we walk the rendered HTML as text and patch only text nodes
  // that contain the markers. This avoids re-rendering and respects code blocks (which become <pre>).
  function decorateLinks(rootEl, sourcesById) {
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode: n => {
        if (n.parentElement && n.parentElement.closest("pre,code")) return NodeFilter.FILTER_REJECT;
        return /\[\[[^\]]+\]\]/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const targets = [];
    let n; while ((n = walker.nextNode())) targets.push(n);
    for (const node of targets) {
      const frag = document.createDocumentFragment();
      const text = node.nodeValue;
      let last = 0;
      const re = /\[\[(mem:[0-9a-f-]+|[a-z0-9][a-z0-9-]*)\]\]/g;
      let m;
      while ((m = re.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const target = m[1];
        const a = document.createElement("a");
        if (target.startsWith("mem:")) {
          const id = target.slice(4);
          const src = sourcesById.get(id);
          a.className = "wiki-mem-link";
          a.textContent = src ? src.title : `mem:${id.slice(0, 8)}`;
          a.title = src ? `Memory: ${src.title}` : `Memory ${id} (not in sources)`;
        } else {
          a.className = "wiki-link";
          a.textContent = `[[${target}]]`;
          a.dataset.slug = target;
          a.addEventListener("click", e => { e.preventDefault(); openArticle(target); });
        }
        frag.appendChild(a);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  function renderDetail(article) {
    toolbar().style.display = "none";
    const tags = (article.tags || []).map(t => `<span class="wiki-card-tag">#${escapeHtml(t)}</span>`).join(" ");
    const summary = article.summary
      ? `<div class="wiki-detail-summary">${escapeHtml(article.summary)}</div>` : "";

    // Strip [[...]] before passing to renderMarkdown so it doesn't mangle them, then re-inject as anchors.
    const bodyHtml = (typeof renderMarkdown === "function")
      ? renderMarkdown(article.body_md)
      : `<pre>${escapeHtml(article.body_md)}</pre>`;

    body().innerHTML = `
      <div class="wiki-detail">
        <button class="wiki-detail-back" data-action="toggleWikiPanel" data-action-arg="true">← back to list</button>
        <h1>${escapeHtml(article.title)} ${statusBadge(article.status)}</h1>
        <div class="wiki-card-meta">
          <span>[[${escapeHtml(article.slug)}]]</span>
          <span>rev ${article.revision}</span>
          <span>${fmtDate(article.generated_at)}</span>
          <span>by ${escapeHtml(article.generated_by || "unknown")}</span>
          ${tags}
        </div>
        ${summary}
        <div class="wiki-detail-body">${bodyHtml}</div>
        <div class="wiki-sources">
          <div class="wiki-sources-title">Sources (${article.sources.length})</div>
          <ul>${(article.sources || []).map(s => `<li>${escapeHtml(s.title)}</li>`).join("")}</ul>
        </div>
      </div>`;

    const sourcesById = new Map((article.sources || []).map(s => [s.id, s]));
    decorateLinks(body().querySelector(".wiki-detail-body"), sourcesById);
  }

  async function openArticle(slug) {
    body().innerHTML = `<div class="wiki-empty">Loading ${escapeHtml(slug)}…</div>`;
    try {
      const article = await fetchArticle(slug);
      if (!article) {
        body().innerHTML = `<div class="wiki-empty">Article "${escapeHtml(slug)}" not found.</div>`;
        return;
      }
      renderDetail(article);
    } catch (err) {
      body().innerHTML = `<div class="wiki-empty">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadListOrSearch() {
    body().innerHTML = `<div class="wiki-empty">Loading…</div>`;
    try {
      let articles;
      if (currentStatus === "draft") {
        const r = await fetch("/api/wiki/drafts");
        if (!r.ok) throw new Error(`drafts ${r.status}`);
        articles = (await r.json()).drafts || [];
      } else if (lastQuery) {
        articles = await fetchSearch(lastQuery);
      } else {
        articles = await fetchList();
      }
      if (currentStatus === "draft") {
        renderDraftList(articles);
      } else {
        renderList(articles);
      }
    } catch (err) {
      body().innerHTML = `<div class="wiki-empty">Failed: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderDraftList(drafts) {
    if (!drafts.length) {
      body().innerHTML = `<div class="wiki-empty">No draft articles.</div>`;
      return;
    }
    body().innerHTML = drafts.map(d => `
      <div class="wiki-card" data-slug="${escapeHtml(d.slug)}">
        <div class="wiki-card-title">${escapeHtml(d.title)}</div>
        ${d.summary ? `<div class="wiki-card-summary">${escapeHtml(d.summary)}</div>` : ""}
        <div class="wiki-card-meta">
          <span>[[${escapeHtml(d.slug)}]]</span>
          <span>draft</span>
          <span>by ${escapeHtml(d.generated_by || "unknown")}</span>
        </div>
        <button class="wiki-publish-btn" data-slug="${escapeHtml(d.slug)}">📝 Publish</button>
      </div>
    `).join("");
    body().querySelectorAll(".wiki-publish-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        btn.disabled = true;
        try {
          await fetch(`/api/wiki/drafts/${encodeURIComponent(btn.dataset.slug)}/publish`, { method: "POST" });
          loadListOrSearch();
        } catch { btn.disabled = false; }
      });
    });
  }

  async function updateDraftChip() {
    try {
      const r = await fetch("/api/wiki/drafts");
      if (!r.ok) return;
      const data = await r.json();
      const count = (data.drafts || []).length;
      const chip = document.getElementById("wikiDraftChip");
      if (chip) {
        chip.style.display = count > 0 ? "" : "none";
        chip.textContent = count > 0 ? `draft (${count})` : "draft";
      }
    } catch { /* non-essential */ }
  }

  function wireToolbar() {
    if (toolbar().dataset.wired) return;
    toolbar().dataset.wired = "1";

    input().addEventListener("input", e => {
      lastQuery = e.target.value.trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadListOrSearch, 250);
    });
    toolbar().querySelectorAll(".wiki-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        toolbar().querySelectorAll(".wiki-chip").forEach(c => c.classList.remove("wiki-chip--active"));
        chip.classList.add("wiki-chip--active");
        currentStatus = chip.dataset.status;
        loadListOrSearch();
      });
    });
  }

  // forceList=true forces the list view even if a detail was open.
  window.toggleWikiPanel = function (forceList) {
    const p = panel(), b = backdrop();
    const opening = p.style.display === "none";
    if (opening) {
      p.style.display = "flex";
      b.style.display = "block";
      wireToolbar();
      updateDraftChip();
      loadListOrSearch();
    } else if (forceList === true) {
      loadListOrSearch();
    } else {
      p.style.display = "none";
      b.style.display = "none";
    }
  };
})();

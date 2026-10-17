// public/scripts/codegraph-map.js
// "Codegraph Atlas" — the Map mode of the code-graph panel (#283 step 6).
// The codebase as a night sky: symbols are stars (brightness = degree),
// communities are constellations with nebula glows, extracted edges are solid
// constellation lines, inferred edges faint and dashed, and a traced path is a
// golden route across the sky. Light theme reads as a paper star atlas.
//
// Consumes the live endpoints (/api/codegraph/graph, /insights, /path); the
// panel owns the symbol-detail flow and passes `onSymbolClick(qualified)`.
// All source-derived text is set via textContent / D3 .text() — never innerHTML.

(() => {
  const PAL_N = 10;              // .cgm-c0..9 star palette classes in CSS
  const GRAPH_LIMIT = 300;       // default bounded fetch (server hard-caps at 1000)
  const OVERVIEW_THRESHOLD = 1000; // above this, open at the constellation overview

  let d3Ready = null;
  function loadD3() {
    // Lazy: the ~280 KB library is only fetched the first time Map mode opens.
    if (window.d3) return Promise.resolve();
    if (d3Ready) return d3Ready;
    d3Ready = new Promise((resolveP, rejectP) => {
      const s = document.createElement("script");
      s.src = "/vendor/d3.min.js";
      s.onload = () => resolveP();
      s.onerror = () => { d3Ready = null; rejectP(new Error("Could not load the local D3 asset (/vendor/d3.min.js).")); };
      document.head.appendChild(s);
    });
    return d3Ready;
  }

  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Deterministic PRNG for background dust — same sky every open.
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };

  // ── Module state (survives list↔map switches while the panel stays open) ──
  const S = {
    container: null, opts: null, abort: null,
    payload: null, repo: null,            // last /graph payload + the repo it was for
    data: null, sim: null, ro: null,
    svg: null, gRoot: null, zoom: null, userMoved: false,
    nodeSel: null, linkSel: null, nebSel: null, constSel: null,
    selectedQualified: null,
    pathMode: null, pathSource: null, pathTarget: null,
    onPathNodes: new Set(), onPathEdges: new Set(),
    filters: { relations: new Set(["calls", "imports", "extends", "references"]),
               confidence: new Set(["EXTRACTED", "INFERRED"]), community: "" },
    overviewChosen: false,                // large repo: a constellation was picked
  };

  async function get(url) {
    const res = await fetch(url, { signal: S.abort?.signal });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  // ══ Public surface ════════════════════════════════════════════════════════
  window.CodegraphMap = {
    async mount(container, opts) {
      // opts: { repo: string, onSymbolClick(qualified) }
      this.unmount();
      S.container = container; S.opts = opts || {};
      S.abort = new AbortController();
      container.classList.add("cg-map");
      showState("loading");
      try {
        await loadD3();
        const repo = S.opts.repo || "";
        if (!S.payload || S.repo !== repo) {
          S.repo = repo;
          S.payload = await fetchGraph([]);
          S.overviewChosen = false;
          resetTransient();
        }
        if (!S.payload.enabled) { showState("error", "The code graph backend is unavailable."); return; }
        if (!S.payload.nodes?.length) { showState("empty"); return; }
        if (S.payload.total_nodes > OVERVIEW_THRESHOLD && !S.overviewChosen) {
          await renderOverview();
        } else {
          renderSky();
        }
      } catch (err) {
        if (err.name !== "AbortError") showState("error", err.message);
      }
    },
    unmount() {
      S.abort?.abort();
      S.sim?.stop();
      S.ro?.disconnect();
      S.sim = S.ro = S.svg = S.gRoot = S.zoom = null;
      S.nodeSel = S.linkSel = S.nebSel = S.constSel = null;
      if (S.container) { S.container.replaceChildren(); S.container.classList.remove("cg-map"); }
      S.container = null;
    },
    // Called by the panel when its repo selector changes while in Map mode.
    setRepo(repo) { if (S.container) this.mount(S.container, { ...S.opts, repo }); },
    // Called from the panel's map-header search box: jump straight to a
    // symbol regardless of overview/community-filter state, refetching with
    // it as focus if the current bounded payload doesn't already include it.
    // A search hit is rarely inside whatever constellation happens to be
    // selected, so this clears the community filter rather than scoping the
    // fetch to it — otherwise the symbol silently fails to appear.
    async focusSymbol(qualified) {
      if (!S.container) return;
      if (!S.data?.byQualified.has(qualified)) {
        showState("loading");
        try { S.payload = await fetchGraph([qualified]); }
        catch (err) { if (err.name !== "AbortError") showState("error", err.message); return; }
        S.overviewChosen = true;
        S.filters.community = "";
        renderSky();
      }
      const node = S.data?.byQualified.get(qualified);
      if (!node) return;
      S.selectedQualified = qualified;
      paintSelection();
      centerOn(node);
      S.opts.onSymbolClick?.(qualified);
    },
  };

  function resetTransient() {
    S.selectedQualified = null;
    S.pathMode = S.pathSource = S.pathTarget = null;
    S.onPathNodes = new Set(); S.onPathEdges = new Set();
    S.filters.community = "";
  }

  // `community`, when set, scopes the fetch server-side to that constellation's
  // members before ranking by degree — without it, a small/low-degree
  // community can be entirely absent from the generic top-N pool and the sky
  // renders empty (every fetched node dims because none belong to it).
  async function fetchGraph(focus, community) {
    const params = new URLSearchParams({ limit: String(GRAPH_LIMIT) });
    if (S.repo) params.set("repo", S.repo);
    for (const f of focus || []) params.append("focus", f);
    if (community) params.set("community", community);
    return get(`/api/codegraph/graph?${params}`);
  }

  // ══ States ════════════════════════════════════════════════════════════════
  function showState(which, message) {
    if (!S.container) return;
    S.sim?.stop(); S.ro?.disconnect();
    S.container.replaceChildren();
    const box = el("div", "cgm-state-box");
    if (which === "loading") {
      box.append(el("div", "cgm-orbit"), el("div", "cgm-state-sub", "Charting the sky…"));
    } else if (which === "empty") {
      box.append(el("div", "cgm-state-icon", "✦"),
                 el("h3", "cgm-state-title", "Uncharted sky"),
                 el("div", "cgm-state-sub", "No symbols indexed for this repository yet. Index a folder to chart its constellations."));
    } else {
      box.append(el("div", "cgm-state-icon cgm-err", "⚠"),
                 el("div", "cgm-state-sub cgm-err", message || "Could not load graph."));
    }
    const wrap = el("div", "cgm-state");
    wrap.append(box);
    S.container.append(wrap);
  }

  // ══ Large-repo constellation overview (K4) ════════════════════════════════
  async function renderOverview() {
    let communities = S.payload.communities || [];
    try {
      const params = new URLSearchParams({ view: "communities", limit: "50" });
      if (S.repo) params.set("repo", S.repo);
      const ins = await get(`/api/codegraph/insights?${params}`);
      if (ins.enabled && ins.communities?.length) communities = ins.communities;
    } catch { /* fall back to the communities in the /graph payload */ }

    S.container.replaceChildren();
    const wrap = el("div", "cgm-overview");
    wrap.append(el("div", "cgm-overview-head",
      `${S.payload.total_nodes} symbols — choose a constellation to chart it.`));
    const grid = el("div", "cgm-overview-grid");
    for (const c of communities) {
      const card = el("button", `cgm-comm-card cgm-c${((c.community_id % PAL_N) + PAL_N) % PAL_N}`);
      card.type = "button";
      card.append(el("span", "cgm-comm-star", "✦"),
                  el("span", "cgm-comm-label", c.label),
                  el("span", "cgm-comm-meta", `${c.size} symbols · cohesion ${Number(c.cohesion ?? 0).toFixed(2)}`));
      card.addEventListener("click", async () => {
        S.overviewChosen = true;
        S.filters.community = String(c.community_id);
        showState("loading");
        try { S.payload = await fetchGraph([], S.filters.community); }
        catch (err) { if (err.name !== "AbortError") showState("error", err.message); return; }
        renderSky();
      });
      grid.append(card);
    }
    wrap.append(grid);
    const all = el("button", "cgm-overview-all", "Show the whole sky (bounded to the brightest symbols)");
    all.type = "button";
    all.addEventListener("click", () => { S.overviewChosen = true; S.filters.community = ""; renderSky(); });
    wrap.append(all);
    S.container.append(wrap);
  }

  // ══ Sky rendering ═════════════════════════════════════════════════════════
  const radius = d => d.kind === "file" ? 7 : Math.max(6, 5.5 + Math.sqrt(d.degree || 0) * 2.3);
  const pal = d => ((d.community_id ?? 0) % PAL_N + PAL_N) % PAL_N;

  function renderSky() {
    const payload = S.payload;
    S.container.replaceChildren();
    S.container.append(buildControls(payload));
    const skyWrap = el("div", "cgm-sky");
    S.container.append(skyWrap);
    skyWrap.append(buildLegend(payload));
    const trunc = buildTruncation(payload);
    if (trunc) skyWrap.append(trunc);
    const pathCard = el("div", "cgm-pathcard"); pathCard.id = "cgmPathCard"; pathCard.hidden = true;
    skyWrap.append(pathCard);

    const svg = d3.select(skyWrap).append("svg")
      .attr("class", "cgm-svg").attr("role", "application")
      .attr("aria-label", "Interactive code graph. Tab moves between stars, Enter selects or assigns a path endpoint.");
    S.svg = svg;

    const defs = svg.append("defs");
    for (const id of ["cgm-arrow-ext", "cgm-arrow-inf"]) {
      defs.append("marker")
        .attr("id", id).attr("viewBox", "0 -5 10 10").attr("refX", 20).attr("refY", 0)
        .attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto")
        .append("path").attr("d", "M0,-4L8,0L0,4")
        .attr("class", id === "cgm-arrow-inf" ? "cgm-arrow inferred" : "cgm-arrow");
    }
    // Per-palette gradients; stop colors track the theme's --cgm-star-N vars.
    for (let i = 0; i < PAL_N; i++) {
      const core = defs.append("radialGradient").attr("id", `cgmCore${i}`);
      core.append("stop").attr("offset", "0%")
        .style("stop-color", `color-mix(in srgb, var(--cgm-star-${i}) 30%, var(--cgm-glow-core))`);
      core.append("stop").attr("offset", "100%").style("stop-color", `var(--cgm-star-${i})`);
      const halo = defs.append("radialGradient").attr("id", `cgmHalo${i}`);
      halo.append("stop").attr("offset", "0%").style("stop-color", `var(--cgm-star-${i})`).style("stop-opacity", 0.9);
      halo.append("stop").attr("offset", "60%").style("stop-color", `var(--cgm-star-${i})`).style("stop-opacity", 0.25);
      halo.append("stop").attr("offset", "100%").style("stop-color", `var(--cgm-star-${i})`).style("stop-opacity", 0);
      const neb = defs.append("radialGradient").attr("id", `cgmNeb${i}`);
      neb.append("stop").attr("offset", "0%").style("stop-color", `var(--cgm-star-${i})`).style("stop-opacity", 0.5);
      neb.append("stop").attr("offset", "70%").style("stop-color", `var(--cgm-star-${i})`).style("stop-opacity", 0.14);
      neb.append("stop").attr("offset", "100%").style("stop-color", `var(--cgm-star-${i})`).style("stop-opacity", 0);
    }

    const gDust = svg.append("g");
    const gRoot = svg.append("g");
    S.gRoot = gRoot;
    const gNeb = gRoot.append("g"), gLinks = gRoot.append("g"),
          gNodes = gRoot.append("g"), gConst = gRoot.append("g");

    // Zoom: responsive wheel (2× the D3 default step), no auto-fit fighting —
    // once the user pans/zooms, the settle-fit stays hands-off.
    S.userMoved = false;
    S.zoom = d3.zoom().scaleExtent([0.1, 5])
      .wheelDelta(e => -e.deltaY * (e.deltaMode === 1 ? 0.10 : e.deltaMode ? 2 : 0.004))
      .on("start", (e) => { if (e.sourceEvent) S.userMoved = true; })
      .on("zoom", (e) => gRoot.attr("transform", e.transform));
    svg.call(S.zoom).on("dblclick.zoom", null);

    // Data copy (force sim mutates x/y) + guards: no dangling edges.
    const data = {
      nodes: payload.nodes.map(n => ({ ...n })),
      edges: payload.edges.map(e => ({ ...e })),
    };
    data.byId = new Map(data.nodes.map(n => [n.id, n]));
    data.byQualified = new Map(data.nodes.map(n => [n.qualified, n]));
    data.edges = data.edges.filter(e => data.byId.has(e.src) && data.byId.has(e.dst));
    for (const e of data.edges) { e.source = e.src; e.target = e.dst; }
    const present = new Set(data.nodes.map(n => n.community_id));
    data.communities = (payload.communities || []).filter(c => present.has(c.community_id));
    S.data = data;

    // Constellation nebulas + labels (positions follow the sim).
    S.nebSel = gNeb.selectAll("circle").data(data.communities, c => c.community_id).join("circle")
      .attr("class", "cgm-nebula")
      .attr("fill", c => `url(#cgmNeb${((c.community_id % PAL_N) + PAL_N) % PAL_N})`);
    S.constSel = gConst.selectAll("text").data(data.communities, c => c.community_id).join("text")
      .attr("class", "cgm-const-label").attr("text-anchor", "middle")
      .text(c => c.label);

    S.linkSel = gLinks.selectAll("line").data(data.edges).join("line")
      .attr("class", e => `cgm-link ${e.kind} ${e.confidence === "EXTRACTED" ? "extracted" : "inferred"}`)
      .attr("marker-end", e => `url(#${e.confidence === "EXTRACTED" ? "cgm-arrow-ext" : "cgm-arrow-inf"})`);

    S.nodeSel = gNodes.selectAll("g.cgm-node").data(data.nodes, d => d.id).join(enter => {
      const g = enter.append("g").attr("class", "cgm-node")
        .attr("tabindex", 0).attr("role", "button");
      g.each(function (d) {
        this.setAttribute("aria-label", `${d.kind} ${d.name}, constellation ${d.community_id}`);
      });
      g.append("title").text(d => `${d.qualified} · ${d.kind} · degree ${d.degree}`);
      g.append("circle")
        .attr("class", d => d.degree > 0 ? "cgm-halo tw" : "cgm-halo")
        .attr("r", d => radius(d) * 2.6)
        .attr("fill", d => `url(#cgmHalo${pal(d)})`)
        .each(function (d) {
          this.style.animationDelay = `${(d.id * 137) % 4000}ms`;
          this.style.setProperty("--tw-dur", `${3200 + (d.id * 271) % 2600}ms`);
        });
      g.filter(d => d.kind === "file").append("rect")
        .attr("class", "cgm-glyph")
        .attr("width", d => radius(d) * 1.7).attr("height", d => radius(d) * 1.7)
        .attr("x", d => -radius(d) * 0.85).attr("y", d => -radius(d) * 0.85)
        .attr("rx", 2)
        .attr("fill", d => `url(#cgmCore${pal(d)})`);
      g.filter(d => d.kind !== "file").append("circle")
        .attr("class", "cgm-glyph").attr("r", radius)
        .attr("fill", d => `url(#cgmCore${pal(d)})`);
      g.append("circle").attr("class", "cgm-ring").attr("r", d => radius(d) + 6);
      g.append("text").attr("dy", d => radius(d) + 13).attr("text-anchor", "middle")
        .text(d => d.name);
      // Generous invisible hit-area so presence responds to hover, not just a
      // precise click on the small core.
      g.append("circle").attr("class", "cgm-hit").attr("r", d => radius(d) + 14);
      return g;
    });

    S.nodeSel
      .on("click", (_e, d) => onNodePick(d))
      .on("keydown", (e, d) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onNodePick(d); }
      })
      // Presence: light up the star's own constellation lines while hovered.
      .on("pointerenter", (_e, d) => {
        S.linkSel.classed("lit", e => e.src === d.id || e.dst === d.id);
      })
      .on("pointerleave", () => S.linkSel.classed("lit", false))
      .call(d3.drag()
        .on("start", (e, d) => { if (!e.active && !reducedMotion()) S.sim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on("end", (e, d) => { if (!e.active) S.sim?.alphaTarget(0); d.fx = null; d.fy = null; }));

    const { width, height } = skyWrap.getBoundingClientRect();
    S.sim = d3.forceSimulation(data.nodes)
      .force("link", d3.forceLink(data.edges).id(d => d.id).distance(70).strength(0.4))
      .force("charge", d3.forceManyBody().strength(-260))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide(d => radius(d) + 10))
      .force("x", d3.forceX(width / 2).strength(0.03))
      .force("y", d3.forceY(height / 2).strength(0.03))
      .on("tick", ticked);

    buildDust(gDust, skyWrap);
    if (reducedMotion()) {
      S.sim.stop();
      for (let i = 0; i < 220; i++) S.sim.tick();
      ticked();
      fit();
    } else {
      S.sim.alpha(1).restart();
      S.sim.on("end", () => { if (!S.userMoved) fit(); });
    }

    S.ro = new ResizeObserver(() => {
      if (!S.sim) return;
      const r = skyWrap.getBoundingClientRect();
      S.sim.force("center", d3.forceCenter(r.width / 2, r.height / 2));
      buildDust(gDust, skyWrap);
      if (!reducedMotion() && !S.userMoved) S.sim.alpha(0.3).restart();
    });
    S.ro.observe(skyWrap);

    // Re-select / re-highlight state carried across re-renders (path refetches).
    if (S.selectedQualified && data.byQualified.has(S.selectedQualified)) paintSelection();
    applyFilters();
    updatePathButtons();
  }

  function buildDust(gDust, skyWrap) {
    const { width, height } = skyWrap.getBoundingClientRect();
    const rnd = mulberry32(42);
    const pts = d3.range(110).map((_, i) => ({
      x: rnd() * width, y: rnd() * height,
      r: 0.3 + rnd() * 1.1, o: 0.10 + rnd() * 0.45, tw: i % 6 === 0,
    }));
    gDust.selectAll("circle").data(pts).join("circle")
      .attr("cx", d => d.x).attr("cy", d => d.y).attr("r", d => d.r)
      .attr("class", d => d.tw ? "cgm-dust tw" : "cgm-dust")
      .style("opacity", d => d.o)
      .each(function (_d, i) { if (this.classList.contains("tw")) this.style.animationDelay = `${(i * 311) % 5000}ms`; });
  }

  function ticked() {
    S.linkSel
      .attr("x1", e => e.source.x).attr("y1", e => e.source.y)
      .attr("x2", e => e.target.x).attr("y2", e => e.target.y);
    S.nodeSel.attr("transform", d => `translate(${d.x},${d.y})`);
    updateConstellations();
  }

  function updateConstellations() {
    if (!S.nebSel || !S.data) return;
    const agg = new Map();
    for (const n of S.data.nodes) {
      let a = agg.get(n.community_id);
      if (!a) { a = { sx: 0, sy: 0, n: 0, nodes: [] }; agg.set(n.community_id, a); }
      a.sx += n.x || 0; a.sy += n.y || 0; a.n++; a.nodes.push(n);
    }
    for (const a of agg.values()) {
      a.cx = a.sx / a.n; a.cy = a.sy / a.n;
      let max = 0;
      for (const n of a.nodes) {
        const dx = (n.x || 0) - a.cx, dy = (n.y || 0) - a.cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > max) max = d2;
      }
      a.spread = Math.sqrt(max) + 46;
    }
    S.nebSel
      .attr("cx", c => agg.get(c.community_id)?.cx ?? 0)
      .attr("cy", c => agg.get(c.community_id)?.cy ?? 0)
      .attr("r", c => agg.get(c.community_id)?.spread ?? 0);
    S.constSel
      .attr("x", c => agg.get(c.community_id)?.cx ?? 0)
      .attr("y", c => (agg.get(c.community_id)?.cy ?? 0) - (agg.get(c.community_id)?.spread ?? 0) - 6);
  }

  function fit() {
    if (!S.data?.nodes.length || !S.svg) return;
    const xs = S.data.nodes.map(n => n.x), ys = S.data.nodes.map(n => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const { width, height } = S.svg.node().getBoundingClientRect();
    const gw = maxX - minX || 1, gh = maxY - minY || 1;
    const scale = Math.min(3, 0.85 * Math.min(width / gw, height / gh));
    const tx = width / 2 - scale * (minX + maxX) / 2;
    const ty = height / 2 - scale * (minY + maxY) / 2;
    S.svg.transition().duration(reducedMotion() ? 0 : 400)
      .call(S.zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }

  function centerOn(node) {
    if (!S.svg || !S.zoom || node.x == null || node.y == null) return;
    const { width, height } = S.svg.node().getBoundingClientRect();
    const scale = Math.max(1, Math.min(3, d3.zoomTransform(S.svg.node()).k || 1.4));
    const tx = width / 2 - scale * node.x, ty = height / 2 - scale * node.y;
    S.userMoved = true;
    S.svg.transition().duration(reducedMotion() ? 0 : 450)
      .call(S.zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }

  // ══ Filters / selection / path ════════════════════════════════════════════
  function edgeVisible(e) {
    if (!S.filters.relations.has(e.kind)) return false;
    if (!S.filters.confidence.has(e.confidence)) return false;
    if (S.filters.community !== "") {
      const s = S.data.byId.get(e.src), t = S.data.byId.get(e.dst);
      if (String(s?.community_id) !== S.filters.community && String(t?.community_id) !== S.filters.community) return false;
    }
    return true;
  }
  const nodeVisible = n => S.filters.community === "" || String(n.community_id) === S.filters.community;

  function applyFilters() {
    if (!S.data || !S.nodeSel) return;
    S.nodeSel.classed("dim", n => !nodeVisible(n));
    S.nebSel.classed("dim", c => S.filters.community !== "" && String(c.community_id) !== S.filters.community);
    S.constSel.classed("dim", c => S.filters.community !== "" && String(c.community_id) !== S.filters.community);
    S.linkSel.classed("dim", e => !pathHasLocalEdge(e) && !edgeVisible(e));
    paintSelection();
    paintPath();
  }

  function onNodePick(d) {
    if (S.pathMode === "source") { S.pathSource = d.qualified; S.pathMode = null; updatePathButtons(); tryPath(); return; }
    if (S.pathMode === "target") { S.pathTarget = d.qualified; S.pathMode = null; updatePathButtons(); tryPath(); return; }
    S.selectedQualified = d.qualified;
    paintSelection();
    S.opts.onSymbolClick?.(d.qualified);   // existing panel detail flow
  }

  function paintSelection() {
    S.nodeSel?.classed("selected", n => n.qualified === S.selectedQualified);
  }

  // S.onPathEdges stores qualified-name keys ("a→b:kind"); local /graph edges
  // carry numeric ids, so resolve through byId and accept either direction.
  function pathHasLocalEdge(e) {
    if (!S.onPathEdges.size || !S.data) return false;
    const a = S.data.byId.get(e.src)?.qualified, b = S.data.byId.get(e.dst)?.qualified;
    return S.onPathEdges.has(`${a}→${b}:${e.kind}`) || S.onPathEdges.has(`${b}→${a}:${e.kind}`);
  }

  async function tryPath() {
    S.onPathNodes = new Set(); S.onPathEdges = new Set();
    const card = document.getElementById("cgmPathCard");
    if (!S.pathSource || !S.pathTarget) { paintPath(); if (card) card.hidden = true; return; }
    try {
      const params = new URLSearchParams({ from: S.pathSource, to: S.pathTarget, directed: "false" });
      if (S.repo) params.set("repo", S.repo);
      const pr = await get(`/api/codegraph/path?${params}`);
      if (!pr.enabled) throw new Error("Code graph backend unavailable.");
      if (!pr.found) { showPathCard(null); paintPath(); return; }
      // The route may cross stars the bounded payload omitted: refetch with the
      // path nodes as focus so every hop is present, then highlight (K3).
      const qualifieds = pr.nodes.map(n => n.qualified);
      const missing = qualifieds.some(q => !S.data.byQualified.has(q));
      if (missing) {
        S.payload = await fetchGraph(qualifieds);
        renderSky();
      }
      for (const q of qualifieds) S.onPathNodes.add(q);
      for (const e of pr.edges) S.onPathEdges.add(`${e.from}→${e.to}:${e.kind}`);
      showPathCard(pr);
      applyFilters();
    } catch (err) {
      if (err.name !== "AbortError") showPathCard(null, err.message);
    }
    updatePathButtons();
  }

  function paintPath() {
    S.nodeSel?.classed("on-path", n => S.onPathNodes.has(n.qualified));
    S.linkSel?.classed("on-path", e => pathHasLocalEdge(e));
  }

  function showPathCard(pr, errMsg) {
    const card = document.getElementById("cgmPathCard");
    if (!card) return;
    card.hidden = false; card.replaceChildren();
    if (errMsg) { card.append(el("div", "cgm-path-title", `Path error: ${errMsg}`)); return; }
    if (!pr) { card.append(el("div", "cgm-path-title", "No path found (disconnected).")); return; }
    card.append(el("div", "cgm-path-title", `Path · ${pr.hop_count} hop${pr.hop_count === 1 ? "" : "s"}`));
    const ol = document.createElement("ol");
    for (const n of pr.nodes) ol.append(el("li", null, n.qualified));
    card.append(ol);
  }

  // ══ Controls / legend / truncation ════════════════════════════════════════
  function buildControls(payload) {
    const bar = el("div", "cgm-controls");

    const zoomGrp = el("div", "cgm-ctl-group");
    for (const [label, title, fn] of [
      ["+", "Zoom in", () => S.svg.transition().duration(120).call(S.zoom.scaleBy, 1.4)],
      ["−", "Zoom out", () => S.svg.transition().duration(120).call(S.zoom.scaleBy, 0.7)],
      ["Fit", "Fit graph to view", () => { S.userMoved = false; fit(); }],
    ]) {
      const b = el("button", "cgm-btn", label);
      b.type = "button"; b.title = title;
      b.addEventListener("click", () => { S.userMoved = true; fn(); });
      zoomGrp.append(b);
    }
    bar.append(zoomGrp);

    const commSel = document.createElement("select");
    commSel.className = "cg-select cgm-comm-select";
    commSel.setAttribute("aria-label", "Filter by constellation");
    const all = el("option", null, "All constellations"); all.value = "";
    commSel.append(all);
    for (const c of (payload.communities || [])) {
      const o = el("option", null, `${c.label} (${c.size})`);
      o.value = String(c.community_id);
      commSel.append(o);
    }
    const ids = new Set((payload.communities || []).map(c => String(c.community_id)));
    if (S.filters.community !== "" && !ids.has(S.filters.community)) S.filters.community = "";
    commSel.value = S.filters.community;
    commSel.addEventListener("change", async () => {
      S.filters.community = commSel.value;
      showState("loading");
      try { S.payload = await fetchGraph([], S.filters.community || undefined); }
      catch (err) { if (err.name !== "AbortError") showState("error", err.message); return; }
      renderSky();
      tryPath();
    });
    bar.append(commSel);

    const mkChecks = (defs, set) => {
      const grp = el("div", "cgm-ctl-group");
      for (const [value, label, cls] of defs) {
        const lab = el("label", "cgm-chk");
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = set.has(value);
        cb.addEventListener("change", () => {
          cb.checked ? set.add(value) : set.delete(value);
          tryPath(); applyFilters();
        });
        lab.append(cb);
        if (cls) lab.append(el("span", `cgm-relmark ${cls}`));
        lab.append(el("span", null, label));
        grp.append(lab);
      }
      return grp;
    };
    bar.append(mkChecks([
      ["calls", "calls", "calls"], ["imports", "imports", "imports"],
      ["extends", "extends", "extends"], ["references", "refs", "references"],
    ], S.filters.relations));
    bar.append(mkChecks([
      ["EXTRACTED", "extracted", null], ["INFERRED", "inferred", null],
    ], S.filters.confidence));

    const pathGrp = el("div", "cgm-ctl-group");
    const src = el("button", "cgm-btn", "Path: source"); src.type = "button"; src.id = "cgmPathSrc";
    const dst = el("button", "cgm-btn", "target"); dst.type = "button"; dst.id = "cgmPathDst";
    const clr = el("button", "cgm-btn", "clear"); clr.type = "button";
    src.addEventListener("click", () => { S.pathMode = S.pathMode === "source" ? null : "source"; updatePathButtons(); });
    dst.addEventListener("click", () => { S.pathMode = S.pathMode === "target" ? null : "target"; updatePathButtons(); });
    clr.addEventListener("click", () => {
      S.pathMode = S.pathSource = S.pathTarget = null;
      S.onPathNodes = new Set(); S.onPathEdges = new Set();
      const card = document.getElementById("cgmPathCard"); if (card) card.hidden = true;
      paintPath(); applyFilters(); updatePathButtons();
    });
    pathGrp.append(src, dst, clr);
    bar.append(pathGrp);
    return bar;
  }

  function updatePathButtons() {
    const src = document.getElementById("cgmPathSrc"), dst = document.getElementById("cgmPathDst");
    if (src) src.setAttribute("aria-pressed", String(S.pathMode === "source"));
    if (dst) dst.setAttribute("aria-pressed", String(S.pathMode === "target"));
  }

  function buildLegend(payload) {
    const box = el("div", "cgm-legend");
    box.append(el("h4", null, "Constellations"));
    for (const c of (payload.communities || [])) {
      const li = el("div", "cgm-legend-li");
      li.append(el("span", `cgm-swatch cgm-c${((c.community_id % PAL_N) + PAL_N) % PAL_N}`),
                el("span", null, `${c.label} · ${c.size}`));
      box.append(li);
    }
    box.append(document.createElement("hr"));
    const mag = el("div", "cgm-legend-li"); mag.append(el("span", null, "✦"), el("span", null, "brightness = degree")); box.append(mag);
    const ext = el("div", "cgm-legend-li"); ext.append(el("span", "cgm-line"), el("span", null, "extracted (1.0)")); box.append(ext);
    const inf = el("div", "cgm-legend-li"); inf.append(el("span", "cgm-line dash"), el("span", null, "inferred (0.8)")); box.append(inf);
    return box;
  }

  function buildTruncation(payload) {
    if (!payload.truncated) return null;
    const box = el("div", "cgm-trunc");
    box.append(el("strong", null, `Showing the ${payload.returned_nodes} brightest of ${payload.total_nodes} symbols.`),
               document.createTextNode(" Choose a constellation to drill in."));
    return box;
  }
})();

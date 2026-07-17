// Dataset Lab deliberately stays local: only the selected public dataset rows
// are fetched, and benchmark artifacts remain private runtime files.
let datasetLabOpen = false;
let datasetLabCatalog = [];

window.toggleDatasetLabPanel = async function () {
  datasetLabOpen = !datasetLabOpen;
  const panel = document.getElementById("dataset-lab-panel");
  const backdrop = document.getElementById("dataset-lab-backdrop");
  if (panel) {
    panel.style.display = datasetLabOpen ? "flex" : "none";
    panel.classList.toggle("open", datasetLabOpen);
  }
  if (backdrop) {
    backdrop.style.display = datasetLabOpen ? "block" : "none";
    backdrop.classList.toggle("open", datasetLabOpen);
  }
  if (datasetLabOpen && !datasetLabCatalog.length) await loadDatasetCatalog();
};

async function loadDatasetCatalog() {
  const body = document.getElementById("dataset-lab-body");
  try {
    const response = await fetch("/api/datasets/catalog");
    const data = await response.json();
    datasetLabCatalog = data.datasets ?? [];
    body.innerHTML = `<div class="dataset-lab-form">
      <label>Dataset <select id="dataset-lab-dataset">${datasetLabCatalog.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.id)} — ${escapeHtml(d.task)}</option>`).join("")}</select></label>
      <label>Split <input id="dataset-lab-split" value="test"></label>
      <label>Rows <input id="dataset-lab-limit" type="number" min="1" max="10000" value="25"></label>
      <label><input id="dataset-lab-fulltext" type="checkbox" checked> FTS5</label>
      <label><input id="dataset-lab-vector" type="checkbox" checked> Vector</label>
      <label><input id="dataset-lab-hybrid" type="checkbox" checked> Hybrid</label>
      <button id="dataset-lab-run" type="button">Run experiment</button>
    </div><div id="dataset-lab-license"></div><div id="dataset-lab-results"></div>`;
    document.getElementById("dataset-lab-dataset").addEventListener("change", renderDatasetLicense);
    document.getElementById("dataset-lab-run").addEventListener("click", runDatasetLab);
    renderDatasetLicense();
  } catch (err) { body.textContent = `Dataset Lab unavailable: ${err.message}`; }
}

function renderDatasetLicense() {
  const d = datasetLabCatalog.find(x => x.id === document.getElementById("dataset-lab-dataset")?.value);
  const el = document.getElementById("dataset-lab-license");
  if (el && d) el.textContent = `${d.purpose}. License: ${d.license}. ${d.citation}`;
}

async function runDatasetLab() {
  const modes = ["fulltext", "vector", "hybrid"].filter(mode => document.getElementById(`dataset-lab-${mode}`)?.checked);
  const config = { dataset: document.getElementById("dataset-lab-dataset").value, split: document.getElementById("dataset-lab-split").value.trim(), limit: Number(document.getElementById("dataset-lab-limit").value), modes, topK: [1,5,10] };
  const output = document.getElementById("dataset-lab-results"); output.textContent = "Running…";
  try { const created = await fetch("/api/datasets/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) }).then(r => r.json()); await pollDatasetRun(created.id); }
  catch (err) { output.textContent = err.message; }
}
async function pollDatasetRun(id) { const output = document.getElementById("dataset-lab-results"); const run = await fetch(`/api/datasets/runs/${encodeURIComponent(id)}`).then(r=>r.json()); if (run.status === "complete") { const s=run.summary; output.innerHTML=`<p>Recall@1 ${(s.recallAt1*100).toFixed(1)}% · Recall@5 ${(s.recallAt5*100).toFixed(1)}% · MRR ${s.mrr.toFixed(3)} · ${s.meanLatencyMs.toFixed(1)} ms</p><p>${s.emptyResultCount} empty results, ${s.embeddingFailureCount} embedding failures</p>`; return; } if (run.status === "failed") { output.textContent=`Run failed: ${run.error}`; return; } output.textContent=`${run.status}…`; setTimeout(()=>pollDatasetRun(id),500); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

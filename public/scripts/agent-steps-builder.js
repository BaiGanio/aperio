// Schema-driven editor for deterministic background-job steps.
// Kept separate from agents-panel.js so the jobs/runs/form controller does not
// also own heterogeneous tool-field rendering and drag/drop state.
(() => {
  function createAgentStepsBuilder({
    tools,
    initialSteps,
    list,
    raw,
    addButton,
    message,
    escapeHtml,
    jsonErrorDetail,
  }) {
    let steps = initialSteps.map(step => ({ ...step, input: { ...(step.input || {}) } }));
    let draggedIndex = null;

    const toolForStep = name => tools.find(tool => tool.name === name);
    const fieldLabel = name => name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    function assertRenderableSteps(value) {
      if (!Array.isArray(value)) throw new TypeError("steps must be an array");
      if (value.some(step => (
        !step
        || typeof step !== "object"
        || Array.isArray(step)
        || typeof step.tool !== "string"
        || (step.input !== undefined && (
          !step.input
          || typeof step.input !== "object"
          || Array.isArray(step.input)
        ))
      ))) {
        throw new TypeError("each step needs a tool name and an object input");
      }
    }

    function defaultInputForTool(tool) {
      const input = {};
      for (const [name, ui] of Object.entries(tool?.fields || {})) {
        if (ui.default !== undefined) input[name] = ui.default;
      }
      return input;
    }

    function renderToolOptions(selected) {
      const unavailable = selected && !toolForStep(selected)
        ? `<option value="${escapeHtml(selected)}" selected>Unavailable: ${escapeHtml(selected)} (raw JSON only)</option>`
        : "";
      return unavailable + tools.map(tool =>
        `<option value="${escapeHtml(tool.name)}"${tool.name === selected ? " selected" : ""}>${escapeHtml(tool.label || tool.name)}</option>`
      ).join("");
    }

    function renderField(step, stepIndex, name, schema, required, ui = {}) {
      const value = step.input?.[name];
      const label = ui.label || fieldLabel(name);
      const help = ui.help || schema.description || "";
      const fieldHead = `<span class="ag-step-field-head"><span>${escapeHtml(label)}${required ? ` <b title="Required">*</b>` : ""}</span>${help ? `<small>${escapeHtml(help)}</small>` : ""}</span>`;
      const attrs = [
        `data-step-field="${escapeHtml(name)}"`,
        `data-step-index="${stepIndex}"`,
        schema.minimum !== undefined ? `min="${schema.minimum}"` : "",
        schema.maximum !== undefined ? `max="${schema.maximum}"` : "",
      ].filter(Boolean).join(" ");

      if (schema.type === "boolean") {
        const checked = value === undefined ? ui.default === true : value === true;
        return `<label class="ag-step-check">
          <input type="checkbox" ${attrs}${checked ? " checked" : ""}>
          <span>${escapeHtml(label)}</span>
          ${help ? `<small>${escapeHtml(help)}</small>` : ""}
        </label>`;
      }
      if (Array.isArray(schema.enum)) {
        return `<label class="ag-step-field">${fieldHead}
          <select ${attrs}>
            ${required ? "" : `<option value="">Use tool default</option>`}
            ${schema.enum.map(option => `<option value="${escapeHtml(option)}"${value === option ? " selected" : ""}>${escapeHtml(option)}</option>`).join("")}
          </select>
        </label>`;
      }
      if (schema.type === "array" || schema.type === "object") {
        const json = value === undefined ? "" : JSON.stringify(value, null, 2);
        return `<label class="ag-step-field">${fieldHead}
          <textarea rows="3" spellcheck="false" data-step-json="true" ${attrs} placeholder="${schema.type === "array" ? "[]" : "{}"}">${escapeHtml(json)}</textarea>
        </label>`;
      }
      const type = schema.type === "number" || schema.type === "integer" ? "number" : "text";
      const stepAttr = type === "number" ? ` step="${schema.type === "integer" ? "1" : "any"}"` : "";
      return `<label class="ag-step-field">${fieldHead}
        <input type="${type}" ${attrs}${stepAttr} value="${escapeHtml(value ?? "")}" placeholder="${required ? "" : "Use tool default"}">
      </label>`;
    }

    function render() {
      list.innerHTML = steps.map((step, index) => {
        const tool = toolForStep(step.tool);
        const schema = tool?.inputSchema || {};
        const properties = schema.properties || {};
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const fields = tool
          ? Object.entries(properties).map(([name, fieldSchema]) =>
              renderField(step, index, name, fieldSchema, required.has(name), tool.fields?.[name])
            ).join("")
          : `<div class="ag-step-warning">This tool is not offered by the visual builder. Its input is preserved and can be edited in Raw JSON.</div>`;
        return `<article class="ag-step-card" data-step-index="${index}" data-testid="agent-step-card">
          <div class="ag-step-head">
            <span class="ag-step-handle" draggable="true" data-drag-index="${index}" data-testid="agent-step-drag-handle" title="Drag to reorder" aria-label="Drag step ${index + 1} to reorder">⠿</span>
            <select class="ag-step-tool" data-step-tool="${index}" aria-label="Tool for step ${index + 1}">
              ${renderToolOptions(step.tool)}
            </select>
            <span class="ag-step-actions">
              <button type="button" class="ag-step-icon" data-step-up="${index}" title="Move up" aria-label="Move step ${index + 1} up"${index === 0 ? " disabled" : ""}>↑</button>
              <button type="button" class="ag-step-icon" data-step-down="${index}" title="Move down" aria-label="Move step ${index + 1} down"${index === steps.length - 1 ? " disabled" : ""}>↓</button>
              <button type="button" class="ag-step-icon delete" data-step-delete="${index}" title="Delete step" aria-label="Delete step ${index + 1}">×</button>
            </span>
          </div>
          <div class="ag-step-body">
            <p class="ag-step-description"><b>Step ${index + 1}.</b> ${escapeHtml(tool?.description || `Unknown tool: ${step.tool}`)}</p>
            ${fields || `<span class="ag-step-empty">No input needed.</span>`}
          </div>
        </article>`;
      }).join("") || `<div class="ag-step-empty-list">No steps yet. Add one below.</div>`;
      raw.value = JSON.stringify(steps, null, 2);
    }

    function move(from, to) {
      if (to < 0 || to >= steps.length || from === to) return;
      const [step] = steps.splice(from, 1);
      steps.splice(to, 0, step);
      render();
    }

    addButton.addEventListener("click", () => {
      const tool = tools[0];
      if (!tool) {
        message.textContent = "⚠ no background-job tools are available";
        return;
      }
      steps.push({ tool: tool.name, input: defaultInputForTool(tool) });
      render();
    });

    list.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.stepUp !== undefined) move(+button.dataset.stepUp, +button.dataset.stepUp - 1);
      if (button.dataset.stepDown !== undefined) move(+button.dataset.stepDown, +button.dataset.stepDown + 1);
      if (button.dataset.stepDelete !== undefined) {
        steps.splice(+button.dataset.stepDelete, 1);
        render();
      }
    });

    list.addEventListener("change", event => {
      const toolIndex = event.target.dataset.stepTool;
      if (toolIndex !== undefined) {
        const tool = toolForStep(event.target.value);
        steps[+toolIndex] = { tool: event.target.value, input: defaultInputForTool(tool) };
        render();
        return;
      }

      const name = event.target.dataset.stepField;
      const index = Number(event.target.dataset.stepIndex);
      if (!name || !Number.isInteger(index) || !steps[index]) return;
      const input = steps[index].input ||= {};
      try {
        if (event.target.type === "checkbox") {
          input[name] = event.target.checked;
        } else if (event.target.dataset.stepJson === "true") {
          if (!event.target.value.trim()) delete input[name];
          else input[name] = JSON.parse(event.target.value);
        } else if (event.target.type === "number") {
          if (event.target.value === "") delete input[name];
          else input[name] = Number(event.target.value);
        } else if (event.target.value === "") {
          delete input[name];
        } else {
          input[name] = event.target.value;
        }
        message.textContent = "";
        raw.value = JSON.stringify(steps, null, 2);
      } catch (err) {
        message.textContent = `⚠ ${fieldLabel(name)} is not valid JSON — ${err.message}`;
      }
    });

    list.addEventListener("dragstart", event => {
      const handle = event.target.closest("[data-drag-index]");
      if (!handle) return;
      draggedIndex = +handle.dataset.dragIndex;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(draggedIndex));
      handle.closest(".ag-step-card")?.classList.add("is-dragging");
    });
    list.addEventListener("dragend", () => {
      list.querySelectorAll(".is-dragging, .is-drop-target").forEach(el => el.classList.remove("is-dragging", "is-drop-target"));
      draggedIndex = null;
    });
    list.addEventListener("dragover", event => {
      const card = event.target.closest(".ag-step-card");
      if (!card || draggedIndex === null) return;
      event.preventDefault();
      list.querySelectorAll(".is-drop-target").forEach(el => el.classList.remove("is-drop-target"));
      card.classList.add("is-drop-target");
    });
    list.addEventListener("drop", event => {
      const card = event.target.closest(".ag-step-card");
      if (!card || draggedIndex === null) return;
      event.preventDefault();
      move(draggedIndex, +card.dataset.stepIndex);
      draggedIndex = null;
    });

    raw.addEventListener("input", () => {
      try {
        const parsed = JSON.parse(raw.value);
        assertRenderableSteps(parsed);
        steps = parsed;
        message.textContent = "";
      } catch (err) {
        message.textContent = `⚠ steps is not valid JSON — ${jsonErrorDetail(raw.value, err)}`;
      }
    });
    raw.addEventListener("blur", () => {
      try {
        const parsed = JSON.parse(raw.value);
        assertRenderableSteps(parsed);
        steps = parsed;
        render();
      } catch { /* keep invalid text and the inline error for correction */ }
    });

    render();
  }

  window.createAgentStepsBuilder = createAgentStepsBuilder;
})();

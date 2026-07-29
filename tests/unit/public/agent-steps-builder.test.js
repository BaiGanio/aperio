import { test } from "node:test";
import assert from "node:assert/strict";

const previousWindow = globalThis.window;
globalThis.window = {};
await import("../../../public/scripts/agent-steps-builder.js");
const createAgentStepsBuilder = globalThis.window.createAgentStepsBuilder;
globalThis.window = previousWindow;

function fakeElement() {
  const listeners = new Map();
  return {
    innerHTML: "",
    value: "",
    textContent: "",
    addEventListener(type, handler) { listeners.set(type, handler); },
    emit(type, event = {}) { return listeners.get(type)?.(event); },
    querySelectorAll() { return []; },
  };
}

const tools = [
  {
    name: "backfill_embeddings",
    label: "Generate missing embeddings",
    description: "Create embeddings.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 100 } },
      required: [],
    },
    fields: {},
  },
  {
    name: "deduplicate_memories",
    label: "Find duplicate memories",
    description: "Find duplicates.",
    inputSchema: {
      type: "object",
      properties: { dry_run: { type: "boolean" } },
      required: [],
    },
    fields: { dry_run: { label: "Preview only", default: true } },
  },
];

test("visual step builder renders schemas and keeps raw JSON synchronized", () => {
  const list = fakeElement();
  const raw = fakeElement();
  const addButton = fakeElement();
  const message = fakeElement();

  createAgentStepsBuilder({
    tools,
    initialSteps: [{ tool: "backfill_embeddings", input: { limit: 10 } }],
    list,
    raw,
    addButton,
    message,
    escapeHtml: value => String(value),
    jsonErrorDetail: (_text, err) => err.message,
  });

  assert.match(list.innerHTML, /Generate missing embeddings/);
  assert.match(list.innerHTML, /Maximum|limit/i);
  assert.deepEqual(JSON.parse(raw.value), [
    { tool: "backfill_embeddings", input: { limit: 10 } },
  ]);

  list.emit("change", {
    target: {
      dataset: { stepTool: "0" },
      value: "deduplicate_memories",
    },
  });
  assert.match(list.innerHTML, /Preview only/);
  assert.deepEqual(JSON.parse(raw.value), [
    { tool: "deduplicate_memories", input: { dry_run: true } },
  ]);

  addButton.emit("click");
  assert.equal(JSON.parse(raw.value).length, 2);
});

test("visual step builder adds, reorders, drags, and deletes synchronized steps", () => {
  const list = fakeElement();
  const raw = fakeElement();
  const addButton = fakeElement();
  const message = fakeElement();
  const cardClassList = { add() {} };
  const clickTarget = dataset => ({
    closest(selector) {
      return selector === "button" ? { dataset } : null;
    },
  });

  createAgentStepsBuilder({
    tools,
    initialSteps: [
      { tool: "backfill_embeddings", input: { limit: 10 } },
      { tool: "deduplicate_memories", input: { dry_run: true } },
    ],
    list,
    raw,
    addButton,
    message,
    escapeHtml: value => String(value),
    jsonErrorDetail: (_text, err) => err.message,
  });

  list.emit("click", { target: clickTarget({ stepDown: "0" }) });
  assert.deepEqual(JSON.parse(raw.value).map(step => step.tool), [
    "deduplicate_memories",
    "backfill_embeddings",
  ]);

  const dragHandle = {
    dataset: { dragIndex: "1" },
    closest(selector) {
      if (selector === "[data-drag-index]") return this;
      if (selector === ".ag-step-card") return { classList: cardClassList };
      return null;
    },
  };
  const dataTransfer = {
    effectAllowed: "",
    setData() {},
  };
  list.emit("dragstart", { target: dragHandle, dataTransfer });
  list.emit("drop", {
    target: {
      closest(selector) {
        return selector === ".ag-step-card" ? { dataset: { stepIndex: "0" } } : null;
      },
    },
    preventDefault() {},
  });
  assert.equal(dataTransfer.effectAllowed, "move");
  assert.deepEqual(JSON.parse(raw.value).map(step => step.tool), [
    "backfill_embeddings",
    "deduplicate_memories",
  ]);

  list.emit("click", { target: clickTarget({ stepDelete: "1" }) });
  assert.deepEqual(JSON.parse(raw.value), [
    { tool: "backfill_embeddings", input: { limit: 10 } },
  ]);

  addButton.emit("click");
  assert.deepEqual(JSON.parse(raw.value), [
    { tool: "backfill_embeddings", input: { limit: 10 } },
    { tool: "backfill_embeddings", input: {} },
  ]);
});

test("raw JSON preserves a registered tool outside the visual catalog", () => {
  const list = fakeElement();
  const raw = fakeElement();
  const addButton = fakeElement();
  const message = fakeElement();

  createAgentStepsBuilder({
    tools,
    initialSteps: [{ tool: "recall", input: { query: "project" } }],
    list,
    raw,
    addButton,
    message,
    escapeHtml: value => String(value),
    jsonErrorDetail: (_text, err) => err.message,
  });

  assert.match(list.innerHTML, /Unavailable: recall/);
  assert.match(list.innerHTML, /preserved.*Raw JSON/);
  assert.deepEqual(JSON.parse(raw.value), [
    { tool: "recall", input: { query: "project" } },
  ]);
});

test("raw JSON rejects malformed step shapes without replacing the visual state", () => {
  const list = fakeElement();
  const raw = fakeElement();
  const addButton = fakeElement();
  const message = fakeElement();

  createAgentStepsBuilder({
    tools,
    initialSteps: [{ tool: "backfill_embeddings", input: {} }],
    list,
    raw,
    addButton,
    message,
    escapeHtml: value => String(value),
    jsonErrorDetail: (_text, err) => err.message,
  });

  raw.value = "[null]";
  raw.emit("input");
  assert.match(message.textContent, /each step needs a tool name/i);
  raw.emit("blur");
  assert.match(list.innerHTML, /Generate missing embeddings/);
});

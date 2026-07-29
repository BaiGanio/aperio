import { zodToJsonSchema } from "../providers/schema.js";

// A deterministic step can technically call any registered MCP tool. The visual
// builder deliberately presents only the small set whose effects make sense in
// an unattended sequence. Raw JSON remains available for existing/power-user
// jobs, and the server validates those against the full live MCP registry.
const BUILDER_TOOL_UI = Object.freeze({
  backfill_embeddings: {
    label: "Generate missing embeddings",
    description: "Create search embeddings for memories that do not have one yet.",
    fields: {
      limit: {
        label: "Maximum memories",
        help: "Maximum memories to process in this run. Leave blank to use the tool default.",
      },
    },
  },
  deduplicate_memories: {
    label: "Find duplicate memories",
    description: "Find near-duplicate memories. Preview mode reports matches without merging them.",
    fields: {
      threshold: {
        label: "Similarity threshold",
        help: "Higher values require a closer match.",
        default: 0.97,
      },
      dry_run: {
        label: "Preview only (do not merge)",
        help: "Turn this off only when you want the job to merge matches automatically.",
        default: true,
      },
    },
  },
  export_data: {
    label: "Back up Aperio data",
    description: "Export memories and wiki articles to a portable JSON backup.",
    fields: {
      output_path: {
        label: "Output path",
        help: "Optional absolute path. Leave blank for a timestamped file in your home folder.",
      },
    },
  },
});

function normalizeTool(tool) {
  return {
    name: tool.name,
    description: tool.description || "",
    inputSchema: zodToJsonSchema(tool.inputSchema),
  };
}

export function buildBackgroundJobToolCatalog(mcpTools = []) {
  const live = new Map(
    (Array.isArray(mcpTools) ? mcpTools : [])
      .filter(tool => tool?.name)
      .map(tool => [tool.name, normalizeTool(tool)]),
  );

  return Object.entries(BUILDER_TOOL_UI).flatMap(([name, ui]) => {
    const tool = live.get(name);
    return tool ? [{ ...tool, label: ui.label, description: ui.description, fields: ui.fields }] : [];
  });
}

function valueType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function validateValue(value, schema, path, errors) {
  if (!schema || typeof schema !== "object") return;
  const expected = schema.type;
  const actual = valueType(value);
  const typeMatches = !expected ||
    actual === expected ||
    (expected === "integer" && actual === "number" && Number.isInteger(value));
  if (!typeMatches) {
    errors.push(`${path} must be ${expected}, received ${actual}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of: ${schema.enum.join(", ")}`);
  }
  if (typeof value === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${path} must be at least ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${path} must be at most ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) errors.push(`${path} is too long`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, errors));
  }
  if (actual === "object") validateObject(value, schema, path, errors);
}

function validateObject(value, schema, path, errors) {
  const properties = schema?.properties ?? {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  for (const name of required) {
    if (value[name] === undefined || value[name] === null || value[name] === "") {
      errors.push(`${path}.${name} is required`);
    }
  }
  for (const [name, fieldValue] of Object.entries(value)) {
    if (!Object.hasOwn(properties, name)) {
      if (schema?.additionalProperties !== true) errors.push(`${path}.${name} is not a recognized input`);
      continue;
    }
    validateValue(fieldValue, properties[name], `${path}.${name}`, errors);
  }
}

export function validateBackgroundJobSteps(steps, mcpTools = []) {
  if (!Array.isArray(steps)) return ["steps must be an array"];
  if (!steps.length) return ["steps must not be empty"];

  const tools = new Map(
    (Array.isArray(mcpTools) ? mcpTools : [])
      .filter(tool => tool?.name)
      .map(tool => [tool.name, normalizeTool(tool)]),
  );
  const errors = [];

  steps.forEach((step, index) => {
    const path = `steps[${index}]`;
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (typeof step.tool !== "string" || !step.tool.trim()) {
      errors.push(`${path}.tool is required`);
      return;
    }
    const tool = tools.get(step.tool);
    if (!tool) {
      errors.push(`${path}.tool "${step.tool}" is not registered`);
      return;
    }
    const input = step.input ?? {};
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      errors.push(`${path}.input must be an object`);
      return;
    }
    validateObject(input, tool.inputSchema, `${path}.input`, errors);
  });

  return errors;
}

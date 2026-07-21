import { z } from "zod";

function inferZodType(zf) {
  const d = zf._def;
  if (d.type) {
    if (d.type === "optional") return inferZodType(d.innerType);
    if (d.type === "enum") return "string";
    if (d.type === "array") return "array";
    return d.type;
  }
  if (d.typeName === "ZodString") return "string";
  if (d.typeName === "ZodNumber") return "number";
  if (d.typeName === "ZodBoolean") return "boolean";
  if (d.typeName === "ZodArray") return "array";
  if (d.typeName === "ZodEnum") return "string";
  return "string";
}

/**
 * Recursively normalize a JSON Schema so that `anyOf` entries with `const`
 * are converted to a form compatible with providers (like Gemini) that do
 * not support the `const` keyword inside function‑declaration parameters.
 *
 * Gemini's protobuf schema defines `enum` as `repeated string`, so only
 * string‑valued `enum` is accepted.  For numeric/boolean const unions we
 * drop the `enum` entirely and emit a bare type — the description still
 * documents the valid values, and the tool's own Zod validation rejects
 * out‑of‑range inputs at call time.
 *
 * Conversions:
 *   { anyOf: [{ const: "a" }, { const: "b" }] }
 *     → { type: "string", enum: ["a", "b"] }
 *
 *   { anyOf: [{ const: 1 }, { const: 2 }] }
 *     → { type: "number" }
 */
function normalizeSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;

  let result = schema;

  // ── Bare `const` (no anyOf wrapper) — same Gemini incompatibility ────
  // A single z.literal(...) embedded directly in an object (e.g. a
  // discriminated-union tag like `type: z.literal("table")`) serializes to
  // `{ const: "table" }` with no sibling branches, so the anyOf collapse
  // below never sees it. Gemini rejects `const` outright regardless of
  // whether it's alone or inside anyOf, so it needs the same treatment.
  if ("const" in schema && !Array.isArray(schema.anyOf)) {
    const value = schema.const;
    if (typeof value === "string") {
      result = { type: "string", enum: [value] };
    } else {
      result = {};
      const t = schema.type || (typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : undefined);
      if (t) result.type = t;
    }
    if (schema.description) result.description = schema.description;
    return result;
  }

  // ── Collapse anyOf → bare type or string enum ───────────────────────
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const constBranches = schema.anyOf.filter(
      e => e && typeof e === "object" && "const" in e,
    );
    if (constBranches.length === schema.anyOf.length) {
      const values = constBranches.map(e => e.const);
      const allStrings = values.every(v => typeof v === "string");

      // Infer type from the branches (prefer explicit), else JS typeof
      const types = [...new Set(constBranches
        .filter(e => typeof e.type === "string")
        .map(e => e.type))];
      const inferredType = types.length === 1
        ? types[0]
        : values.every(v => typeof v === "number")
          ? "number"
          : values.every(v => typeof v === "boolean")
            ? "boolean"
            : undefined;

      if (allStrings) {
        // String enum — Gemini accepts this.
        result = { type: "string", enum: values };
      } else {
        // Non‑string const union → bare type without enum.
        // Gemini's enum only accepts strings, so we drop it.
        result = {};
        if (inferredType) result.type = inferredType;
      }
      if (schema.description) result.description = schema.description;
      return result;
    }
  }

  // ── Deep walk ───────────────────────────────────────────────────────
  if (schema.properties && typeof schema.properties === "object") {
    result = { ...result, properties: {} };
    for (const [k, v] of Object.entries(schema.properties)) {
      result.properties[k] = normalizeSchema(v);
    }
  }

  if (schema.items && typeof schema.items === "object") {
    result = { ...result, items: normalizeSchema(schema.items) };
  }

  // anyOf entries that weren't handled above still need to be walked
  if (Array.isArray(schema.anyOf)) {
    result = { ...result, anyOf: schema.anyOf.map(e => normalizeSchema(e)) };
  }

  if (Array.isArray(schema.oneOf)) {
    result = { ...result, oneOf: schema.oneOf.map(e => normalizeSchema(e)) };
  }

  return result;
}

export function zodToJsonSchema(zs) {
  if (!zs?._def) {
    const { $schema, ...rest } = zs ?? { type: "object", properties: {}, required: [] };
    return normalizeSchema(rest);
  }
  if (!zs._def.shape) return { type: "object", properties: {}, required: [] };
  const shape = typeof zs._def.shape === "function" ? zs._def.shape() : zs._def.shape;
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(shape)) { properties[k] = { type: inferZodType(v) }; if (v.isOptional && !v.isOptional()) required.push(k); }
  return normalizeSchema({ type: "object", properties, required });
}

// Inverse of zodToJsonSchema: rebuild a Zod raw shape from a JSON Schema object.
// The Claude Agent SDK's `tool()` helper takes a ZodRawShape, but our tools reach
// the claude-code provider as JSON Schema (that's what mcp.listTools() returns over
// stdio). Without this, every tool would advertise an empty parameter list.
function jsonPropToZod(prop) {
  const enumVals = Array.isArray(prop?.enum) ? prop.enum : null;
  if (enumVals && enumVals.length && enumVals.every(v => typeof v === "string")) {
    return z.enum(enumVals);
  }
  switch (prop?.type) {
    case "string":  return z.string();
    case "integer": return z.number().int();
    case "number":  return z.number();
    case "boolean": return z.boolean();
    case "array":   return z.array(prop.items ? jsonPropToZod(prop.items) : z.any());
    case "object":  return prop.properties ? z.object(jsonSchemaToZodShape(prop)) : z.object({}).passthrough();
    default:        return z.any();
  }
}

export function jsonSchemaToZodShape(schema) {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shape = {};
  for (const [key, prop] of Object.entries(props)) {
    let zt = jsonPropToZod(prop);
    if (prop?.description) zt = zt.describe(prop.description);
    if (!required.has(key)) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}

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

export function zodToJsonSchema(zs) {
  if (!zs?._def) { const { $schema, ...rest } = zs ?? { type: "object", properties: {}, required: [] }; return rest; }
  if (!zs._def.shape) return { type: "object", properties: {}, required: [] };
  const shape = typeof zs._def.shape === "function" ? zs._def.shape() : zs._def.shape;
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(shape)) { properties[k] = { type: inferZodType(v) }; if (v.isOptional && !v.isOptional()) required.push(k); }
  return { type: "object", properties, required };
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

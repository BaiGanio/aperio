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
  if (!zs?._def?.shape) return { type: "object", properties: {}, required: [] };
  const shape = typeof zs._def.shape === "function" ? zs._def.shape() : zs._def.shape;
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(shape)) { properties[k] = { type: inferZodType(v) }; if (v.isOptional && !v.isOptional()) required.push(k); }
  return { type: "object", properties, required };
}

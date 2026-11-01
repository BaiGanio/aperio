// AP6 green: a lookup table built once and never mutated is not a cache.
const TOOL_NAMES = new Set(['remember', 'recall', 'forget', 'read_file', 'write_file']);

export function isTool(name) {
  return TOOL_NAMES.has(name);
}

// AP6 violation: a module-level cache that grows for the life of the process.
const cache = new Map();

export function remember(key, value) {
  cache.set(key, value);
  return cache.get(key);
}

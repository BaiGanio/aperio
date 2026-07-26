export function createStore() {
  const data = new Map();

  return {
    get(key) {
      const entry = data.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
        data.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      data.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : undefined });
    },
    has(key) {
      return data.has(key);
    },
    delete(key) {
      return data.delete(key);
    },
    get size() {
      return data.size;
    },
  };
}

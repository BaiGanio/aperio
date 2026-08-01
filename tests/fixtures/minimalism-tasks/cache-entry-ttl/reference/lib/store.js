export function createStore() {
  const data = new Map();

  function isExpired(entry) {
    return entry.expiresAt !== undefined && Date.now() >= entry.expiresAt;
  }

  return {
    get(key) {
      const entry = data.get(key);
      if (!entry) return undefined;
      if (isExpired(entry)) {
        data.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      if (ttlMs !== undefined && (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0)) {
        throw new TypeError("ttlMs must be a non-negative number");
      }
      data.set(key, { value, expiresAt: ttlMs === undefined ? undefined : Date.now() + ttlMs });
    },
    has(key) {
      const entry = data.get(key);
      if (!entry) return false;
      if (isExpired(entry)) {
        data.delete(key);
        return false;
      }
      return true;
    },
    delete(key) {
      return data.delete(key);
    },
    get size() {
      return data.size;
    },
  };
}

export function createStore() {
  const data = new Map();

  return {
    get(key) {
      const entry = data.get(key);
      return entry ? entry.value : undefined;
    },
    set(key, value) {
      data.set(key, { value });
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

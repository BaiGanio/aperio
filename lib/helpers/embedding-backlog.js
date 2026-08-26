let total = 0;

export function getEmbeddingBacklogSize() {
  return total;
}

export function createEmbeddingBacklogTracker() {
  let size = 0;
  let released = false;

  return {
    set(nextSize) {
      if (released) return;
      const next = Math.max(0, Number(nextSize) || 0);
      total += next - size;
      size = next;
    },
    release() {
      if (released) return;
      released = true;
      total -= size;
      size = 0;
    },
  };
}

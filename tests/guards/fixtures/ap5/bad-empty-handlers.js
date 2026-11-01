// AP5 violation: two swallowed errors, neither logged, rethrown nor marked.
export function risky(f) {
  try {
    f();
  } catch {}
}

export function fireAndForget(p) {
  p.catch(() => {});
}

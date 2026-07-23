// Small deterministic module used by the codegraph qualification chain.
export function matchSkill(request, skill) {
  return String(request).toLowerCase().includes(String(skill).toLowerCase());
}

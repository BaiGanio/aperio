export function parseQueryString(qs) {
  const params = new URLSearchParams(String(qs ?? "").replace(/^\?/, ""));
  return Object.fromEntries(params.entries());
}

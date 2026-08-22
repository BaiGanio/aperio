import { isAbsolute, join, normalize, relative, resolve } from "node:path";

const BLOCK_SEPARATOR = /\n---\n/;
const PATH_PATTERN = /(?:[A-Za-z]:[\\/][^\s,;]+|\/[\w./-]+)/;

function cleanPath(value) {
  return value?.replace(/[),.;:'"`]+$/, "") || null;
}

export function parseSearchScopes(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("No memories")) return [];
  const scopes = [];
  for (const block of raw.split(BLOCK_SEPARATOR)) {
    const lines = block.trim().split("\n");
    const header = lines[0] || "";
    if (!/^\[PREFERENCE\]\s/i.test(header)) continue;
    const tagsIndex = lines.findIndex(line => /^Tags:\s/i.test(line));
    if (tagsIndex < 0) continue;
    const tags = lines[tagsIndex].replace(/^Tags:\s*/i, "").split(",").map(tag => tag.trim());
    const scopeTag = tags.find(tag => /^scope:/i.test(tag));
    const trigger = scopeTag?.slice(scopeTag.indexOf(":") + 1).trim().toLowerCase();
    if (!trigger) continue;
    const content = lines.slice(1, tagsIndex).join("\n").trim();
    const path = cleanPath(content.match(PATH_PATTERN)?.[0]);
    if (!path) continue;
    const title = header
      .replace(/^\[PREFERENCE\]\s*/i, "")
      .replace(/(?:\s+\[[^\]]+\])*\s+\(importance:.*$/i, "")
      .trim();
    scopes.push({ trigger, path, title, content });
  }
  return scopes;
}

function matchingScopes(scopes, text, preferSpecific = false) {
  const haystack = String(text || "").toLowerCase();
  return scopes
    .map((scope, index) => ({ scope, index }))
    .filter(({ scope }) => {
      const trigger = scope.trigger.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9_])${trigger}($|[^a-z0-9_])`, "i").test(haystack);
    })
    .sort((a, b) => preferSpecific
      ? b.scope.trigger.length - a.scope.trigger.length || a.index - b.index
      : a.index - b.index)
    .map(({ scope }) => scope);
}

export function selectSearchScope(scopes, { userQuery = "", pattern = "" } = {}) {
  if (!Array.isArray(scopes) || scopes.length === 0) return null;
  return matchingScopes(scopes, pattern, true)[0] || matchingScopes(scopes, userQuery)[0] || null;
}

export function resolveScopedSearchPath(scopePath, existingPath) {
  if (typeof scopePath !== "string" || !scopePath.trim()) return existingPath;
  const scope = normalize(resolve(scopePath));
  if (typeof existingPath !== "string" || !existingPath.trim() || existingPath.trim() === ".") return scope;
  const existing = existingPath.trim();
  const absolute = normalize(isAbsolute(existing) ? resolve(existing) : resolve(join(scope, existing)));
  const rel = relative(scope, absolute);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? absolute : scope;
}

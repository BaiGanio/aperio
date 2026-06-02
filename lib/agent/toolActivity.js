/**
 * toolActivity.js — short, safe summaries of a tool call for the UI activity cards.
 *
 * Both functions are pure and intentionally never expose raw payloads: the
 * argument summary picks one salient field and truncates it, and the result
 * summary reports a size/count/status rather than the content. This keeps the
 * WebSocket frames small and avoids leaking page bodies or memory text into the
 * browser DOM.
 */

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// Middle-ellipsis for URLs/paths so both ends stay readable.
const truncMid = (s, n) => (s.length <= n ? s : s.slice(0, n / 2 - 1) + "…" + s.slice(-(n / 2)));
const firstLine = (s) => s.split("\n").find(l => l.trim()) ?? "";

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** One-line summary of the call's arguments (the "for what"). */
export function summarizeArgs(name, args) {
  if (!args || typeof args !== "object") return "";
  const str = (k) => (typeof args[k] === "string" && args[k] ? args[k] : null);
  const url = str("url");
  if (url) return truncMid(url, 60);
  const query = str("query") ?? str("q");
  if (query) return `"${trunc(query, 40)}"`;
  const path = str("path") ?? str("file") ?? str("title");
  if (path) return trunc(path, 50);
  if (typeof args.limit === "number") return `limit: ${args.limit}`;
  const firstStr = Object.values(args).find(v => typeof v === "string" && v);
  return firstStr ? trunc(firstStr, 40) : "";
}

/** { ok, summary } describing the outcome (the "what happened"). */
export function summarizeResult(name, result) {
  if (Array.isArray(result)) return { ok: true, summary: "image" };
  const text = typeof result === "string" ? result : String(result ?? "");
  if (text.startsWith("❌")) return { ok: false, summary: trunc(firstLine(text).replace(/^❌\s*/, ""), 80) };

  if (name === "recall") {
    if (/no memories/i.test(text)) return { ok: true, summary: "no memories" };
    const n = text.split("---").filter(b => b.trim()).length;
    return { ok: true, summary: `${n} ${n === 1 ? "memory" : "memories"}` };
  }
  if (name === "fetch_url") return { ok: true, summary: formatBytes(Buffer.byteLength(text, "utf8")) };

  // Generic: a short result is its own summary; a long one collapses to a size.
  const fl = firstLine(text).trim();
  if (text.length <= 80 && fl) return { ok: true, summary: fl };
  return { ok: true, summary: formatBytes(Buffer.byteLength(text, "utf8")) };
}

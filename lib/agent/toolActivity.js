/**
 * toolActivity.js — short, safe summaries of a tool call for the UI activity cards.
 *
 * Both functions are pure. The summary stays the one-line headline (a
 * size/count/status, not the content) so cards read cleanly and WebSocket
 * frames stay small. For result text that the summary hides, `summarizeResult`
 * also ships the full payload as a capped `detail` string the card expands on
 * click — so the user can always see the whole message instead of a clipped
 * "…". The cap bounds frame size; the headline-first shape is unchanged.
 */

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// How much of a hidden payload we ship for on-demand expansion. Bounds the
// WebSocket frame so a multi-MB fetch_url body can't bloat it.
const DETAIL_CAP = 2000;
// Middle-ellipsis for URLs/paths so both ends stay readable.
const truncMid = (s, n) => (s.length <= n ? s : s.slice(0, n / 2 - 1) + "…" + s.slice(-(n / 2)));
const firstLine = (s) => s.split("\n").find(l => l.trim()) ?? "";

// Attach the full (capped) text as `detail` whenever the summary hides part of
// it, so the card can expand to the complete message. Left untouched when the
// summary already shows everything, or when the result already expands its own
// way (web_search ships a structured `details` list instead).
function withDetail(text, res) {
  if (res.details || res.detail) return res;
  const full = (text || "").trim();
  if (full && full !== res.summary && full.length > res.summary.length)
    return { ...res, detail: trunc(full, DETAIL_CAP) };
  return res;
}

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
  if (url) return truncMid(url, 80);
  // The actual shell command is the most useful thing to surface — show it
  // nearly in full, like a terminal does, before falling back to other fields.
  const command = str("command") ?? str("cmd");
  if (command) return trunc(command, 160);
  const query = str("query") ?? str("q");
  if (query) return `"${trunc(query, 60)}"`;
  // Paths/titles are shown in full: the card drops them to their own wrapping
  // line (tool-card-arg-block), so there's no layout reason to clip them and a
  // middle "…" only hides which file the tool touched.
  const path = str("path") ?? str("file") ?? str("title");
  if (path) return path;
  if (typeof args.limit === "number") return `limit: ${args.limit}`;
  const firstStr = Object.values(args).find(v => typeof v === "string" && v);
  return firstStr ? trunc(firstStr, 160) : "";
}

/** { ok, summary } describing the outcome (the "what happened"). */
export function summarizeResult(name, result) {
  if (Array.isArray(result)) return { ok: true, summary: "image" };
  const text = typeof result === "string" ? result : String(result ?? "");
  if (text.startsWith("❌")) {
    const full = text.replace(/^❌\s*/, "").trim();
    return withDetail(full, { ok: false, summary: trunc(firstLine(full), 80) });
  }

  if (name === "recall") {
    if (/no memories/i.test(text)) return withDetail(text, { ok: true, summary: "no memories" });
    const n = text.split("---").filter(b => b.trim()).length;
    return withDetail(text, { ok: true, summary: `${n} ${n === 1 ? "memory" : "memories"}` });
  }
  if (name === "fetch_url")
    return withDetail(text, { ok: true, summary: formatBytes(Buffer.byteLength(text, "utf8")) });
  if (name === "web_search") {
    // Narrow exception to the "summary only" rule: search hits are small and the
    // whole point is to let the user see what was found and why a source was
    // picked, so we parse the formatted list back into {title, url, snippet} and
    // ship it as `details` for the card to expand. URLs are http(s)-only by
    // construction (see mcp/tools/web.js), safe to render as links.
    const details = [];
    // [ \t]+ for the indent (not \s+) so the optional snippet line can't swallow
    // a following blank line + the trailing instruction text.
    const re = /^\d+\.[ \t]+(.+)\n[ \t]+(https?:\/\/\S+)(?:\n[ \t]+(.+))?/gm;
    let m;
    while ((m = re.exec(text)))
      details.push({ title: m[1].trim(), url: m[2].trim(), snippet: (m[3] || "").trim() });
    const n = details.length;
    return { ok: true, summary: n ? `${n} ${n === 1 ? "result" : "results"}` : "no results", details };
  }

  // Generic: a short result is its own summary; a long one collapses to a size.
  // Either way `withDetail` lets the user expand to the full text when the
  // headline hides any of it (e.g. a multi-line short result, or a long body).
  const fl = firstLine(text).trim();
  if (text.length <= 80 && fl) return withDetail(text, { ok: true, summary: fl });
  return withDetail(text, { ok: true, summary: formatBytes(Buffer.byteLength(text, "utf8")) });
}

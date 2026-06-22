// mcp/tools/web.js
// Web tools: fetch_url, web_search.

import { z } from "zod";
import sanitizeHtml from "sanitize-html";
import { assertPublicUrl } from "../../lib/helpers/ssrfGuard.js";
import { logEgress }       from "../../lib/helpers/egressLog.js";

// ─── Pure handler ─────────────────────────────────────────────────────────────

export async function fetchUrlHandler({ url, max_chars: _max, offset: _offset }) {
  const max_chars = _max !== undefined ? Number.parseInt(_max, 10) : undefined;
  const offset    = _offset !== undefined ? Math.max(0, Number.parseInt(_offset, 10) || 0) : 0;

  try {
    await assertPublicUrl(url);
  } catch (err) {
    return { content: [{ type: "text", text: `❌ ${err.message}` }] };
  }

  try {
    logEgress({ tool: "fetch_url", host: new URL(url).hostname });
    const response = await fetch(url, {
      headers: { "User-Agent": "Aperio/2.0" },
      signal:  AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      return { content: [{ type: "text", text: `❌ HTTP ${response.status}: ${response.statusText}` }] };

    let text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("html")) {
      text = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} })
        .replace(/&nbsp;/g, " ")
        .replace(/\s{3,}/g, "\n\n")
        .trim();
    }

    const limit     = Math.min(max_chars ?? 15_000, 15_000);
    const end       = offset + limit;
    const truncated = text.length > end;
    return {
      content: [{
        type: "text",
        text: `🌐 ${url}\n\n${text.slice(offset, end)}${truncated ? `\n\n⚠️ Truncated at ${end} of ${text.length} chars. Call again with offset: ${end} for the rest.` : ""}`,
      }],
    };
  } catch (err) {
    return { content: [{ type: "text", text: `❌ Fetch failed: ${err.message}` }] };
  }
}

// ─── web_search (DuckDuckGo) ────────────────────────────────────────────────────
// Self-contained: fetches DuckDuckGo's no-JS HTML results page and parses the
// hits itself, returning {title, url, snippet}. No server to run and no API key —
// it works out of the box. The model picks a result and follows up with fetch_url
// to read the page and cite it. Caveat: this scrapes HTML, so a markup change on
// DDG's side or a rate-limit/CAPTCHA on a busy IP can yield zero results.

const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";
// A browser-like UA — DDG serves a CAPTCHA stub to obvious bots.
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// DDG wraps result links as //duckduckgo.com/l/?uddg=<encoded real url>. Unwrap
// to the real destination; pass through direct/protocol-relative hrefs.
function unwrapDdgHref(href) {
  const m = href.match(/[?&]uddg=([^&]+)/);
  let url = m ? decodeURIComponent(m[1]) : href;
  if (url.startsWith("//")) url = "https:" + url;
  return url;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function cleanFragment(html) {
  return decodeEntities(sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }))
    .replace(/\s+/g, " ").trim();
}

// Parse DDG's HTML results page into [{title, url, snippet}].
// Anchored on the result__a links rather than the outer `<div class="result">`:
// DDG nests result__snippet inside child result__body divs, so a naive split on
// that class string severs the title from its snippet. Instead we walk each
// result__a and scan the span up to the next one for that result's snippet.
export function parseDdgResults(html, max) {
  const results = [];
  const re = /result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=result__a"|$)/g;
  let m;
  while ((m = re.exec(html)) && results.length < max) {
    const url   = unwrapDdgHref(m[1]);
    // Skip ads/redirects that don't resolve to an external host (DDG y.js links).
    if (!/^https?:/.test(url) || /^https?:\/\/(?:[^/]*\.)?duckduckgo\.com\//.test(url)) continue;
    const title = cleanFragment(m[2]);
    if (!title) continue;
    const snip  = m[3].match(/result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    results.push({ title, url, snippet: snip ? cleanFragment(snip[1]) : "" });
  }
  return results;
}

export async function webSearchHandler({ query, max_results: _max }) {
  const max_results = _max !== undefined ? Math.min(Math.max(1, Number.parseInt(_max, 10) || 5), 10) : 5;
  const q = String(query ?? "").trim();
  if (!q)
    return { content: [{ type: "text", text: "❌ web_search: empty query." }] };

  const endpoint = `${DDG_ENDPOINT}?q=${encodeURIComponent(q)}`;
  try {
    logEgress({ tool: "web_search", host: "html.duckduckgo.com" });
    const response = await fetch(endpoint, {
      headers: { "User-Agent": BROWSER_UA, "Accept": "text/html" },
      signal:  AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      return { content: [{ type: "text", text: `❌ web_search: HTTP ${response.status} from DuckDuckGo.` }] };

    const results = parseDdgResults(await response.text(), max_results);
    if (results.length === 0)
      return { content: [{ type: "text", text: `🔎 No results for "${q}" (DuckDuckGo may have rate-limited this request — try again shortly).` }] };

    const body = results.map((r, i) =>
      `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
    return { content: [{ type: "text", text: `🔎 Results for "${q}"\n\n${body}\n\nPick the most relevant result and call fetch_url on its URL to read the page. When you answer, cite the source by quoting its full URL — not just the site name.` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `❌ web_search failed: ${err.message}` }] };
  }
}

// ─── MCP registration ─────────────────────────────────────────────────────────

export function register(server, _ctx) {
  server.registerTool(
    "fetch_url",
    {
      description: "Fetch content from a URL. Use this instead of curl — it works within the sandbox, strips HTML tags, and returns up to 15,000 characters per call. Use offset to page through longer content.",
      inputSchema: z.object({
        url:       z.string().url().describe("The URL to fetch"),
        max_chars: z.number().min(500).max(15000).optional().describe("Max characters, default 15000"),
        offset:    z.number().min(0).optional().describe("Character offset to start from, for paging through truncated content"),
      }),
    },
    fetchUrlHandler
  );

  server.registerTool(
    "web_search",
    {
      description: "Search the web for a query and get back a ranked list of results (title, URL, snippet). Use this when you need to find pages but don't have a specific URL — then call fetch_url on a result to read it and cite it as the source.",
      inputSchema: z.object({
        query:       z.string().min(1).describe("The search query"),
        max_results: z.number().min(1).max(10).optional().describe("Number of results to return, default 5"),
      }),
    },
    webSearchHandler
  );
}
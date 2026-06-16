// mcp/tools/web.js
// Web tools: fetch_url.

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
}
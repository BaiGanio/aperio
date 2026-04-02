// mcp/tools/web.js
// Web tools: fetch_url.

import { z } from "zod";

export function register(server, _ctx) {

  // ─── fetch_url ───────────────────────────────────────────────────────────────
  server.registerTool(
    "fetch_url",
    {
      description: "Fetch content from a URL. Strips HTML tags, truncates at 15,000 characters.",
      inputSchema: z.object({
        url:       z.string().url().describe("The URL to fetch"),
        max_chars: z.number().min(500).max(15000).optional().describe("Max characters, default 15000"),
      }),
    },
    async ({ url, max_chars: _max }) => {
      const max_chars = _max !== undefined ? parseInt(_max, 10) : undefined;
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": "Aperio/2.0" },
          signal:  AbortSignal.timeout(10_000),
        });
        if (!response.ok)
          return { content: [{ type: "text", text: `❌ HTTP ${response.status}: ${response.statusText}` }] };

        let text = await response.text();
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("html")) {
          text = text
            .replace(/<script\b[\s\S]*?<\/script(?:\s[^>]*)?>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/\s{3,}/g, "\n\n").trim();
        }

        const limit     = Math.min(max_chars ?? 15_000, 15_000);
        const truncated = text.length > limit;
        return {
          content: [{
            type: "text",
            text: `🌐 ${url}\n\n${text.slice(0, limit)}${truncated ? "\n\n⚠️ Truncated. Ask for more if needed." : ""}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ Fetch failed: ${err.message}` }] };
      }
    }
  );
}
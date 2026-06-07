// mcp/tools/github.js
// GitHub tool: fetch_github_issue

import { z }      from "zod";
import logger     from "../../lib/helpers/logger.js";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const API_BASE     = "https://api.github.com";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function githubHeaders() {
  const headers = {
    "Accept":               "application/vnd.github+json",
    "User-Agent":           "Aperio/2.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GITHUB_TOKEN) headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

function parseIssueUrl(url) {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: m[3] };
}

function extractImageUrls(markdown) {
  const mdImages   = [...markdown.matchAll(/!\[.*?\]\((https?:\/\/[^)\s]+)\)/g)];
  const htmlImages = [...markdown.matchAll(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi)];
  return [...new Set([...mdImages, ...htmlImages].map(m => m[1]))];
}

async function fetchImageAsBase64(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "Aperio/2.0" },
    signal:  AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return null;
  const contentType = resp.headers.get("content-type") ?? "image/jpeg";
  const mimeType    = contentType.split(";")[0].trim();
  if (!mimeType.startsWith("image/")) return null;
  const base64 = Buffer.from(await resp.arrayBuffer()).toString("base64");
  return { base64, mimeType };
}

function formatIssue(issue, comments) {
  const lines = [
    `# ${issue.title}`,
    `**State:** ${issue.state} | **#${issue.number}** | ${issue.html_url}`,
    `**Author:** ${issue.user?.login} | **Created:** ${issue.created_at.slice(0, 10)}`,
  ];
  if (issue.labels?.length)
    lines.push(`**Labels:** ${issue.labels.map(l => l.name).join(", ")}`);
  if (issue.assignees?.length)
    lines.push(`**Assignees:** ${issue.assignees.map(a => a.login).join(", ")}`);

  lines.push("", "## Body", issue.body || "(no body)");

  if (comments?.length) {
    lines.push("", "## Comments");
    for (const c of comments)
      lines.push(`\n### @${c.user?.login} (${c.created_at.slice(0, 10)})`, c.body || "(empty)");
  }
  return lines.join("\n");
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function fetchGithubIssueHandler({ url, include_comments = true, include_images = true }) {
  const parsed = parseIssueUrl(url);
  if (!parsed)
    return { content: [{ type: "text", text: "❌ Invalid GitHub issue URL. Expected: https://github.com/owner/repo/issues/123" }] };

  const { owner, repo, number } = parsed;
  const headers = githubHeaders();

  // ── Fetch issue ──────────────────────────────────────────────────────────────
  let issue;
  try {
    const resp = await fetch(`${API_BASE}/repos/${owner}/${repo}/issues/${number}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { content: [{ type: "text", text: `❌ GitHub API error ${resp.status}: ${body.slice(0, 200)}` }] };
    }
    issue = await resp.json();
  } catch (err) {
    return { content: [{ type: "text", text: `❌ Fetch failed: ${err.message}` }] };
  }

  // ── Fetch comments ───────────────────────────────────────────────────────────
  let comments = [];
  if (include_comments) {
    try {
      const resp = await fetch(
        `${API_BASE}/repos/${owner}/${repo}/issues/${number}/comments?per_page=50`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
      if (resp.ok) comments = await resp.json();
    } catch (err) {
      logger.warn(`⚠️ Could not fetch comments for issue #${number}: ${err.message}`);
    }
  }

  const content = [{ type: "text", text: formatIssue(issue, comments) }];

  // ── Fetch embedded images ────────────────────────────────────────────────────
  if (include_images) {
    const allMarkdown = [issue.body ?? "", ...comments.map(c => c.body ?? "")].join("\n");
    const imageUrls   = extractImageUrls(allMarkdown);

    for (const imgUrl of imageUrls) {
      try {
        const img = await fetchImageAsBase64(imgUrl);
        if (img) {
          content.push({ type: "image", data: img.base64, mimeType: img.mimeType });
          logger.info(`🖼️  github image: ${imgUrl.slice(0, 80)}`);
        }
      } catch (err) {
        logger.warn(`⚠️ Could not fetch image: ${err.message}`);
      }
    }
  }

  return { content };
}

// ─── MCP registration ─────────────────────────────────────────────────────────

export function register(server, _ctx) {
  server.registerTool(
    "fetch_github_issue",
    {
      description:
        "Fetch a GitHub issue by URL — returns the title, state, labels, assignees, body, and comments. " +
        "Also fetches any images embedded in the issue or comments and returns them as image blocks " +
        "so vision models can analyse screenshots, diagrams, or other attachments. " +
        "For text-only local models the image bridge will auto-describe images via the local VLM. " +
        "Set GITHUB_TOKEN env var for private repos or to avoid rate limits (60 req/hr unauthenticated vs 5000 authenticated).",
      inputSchema: z.object({
        url: z.string().url().describe(
          "GitHub issue URL, e.g. https://github.com/owner/repo/issues/123"
        ),
        include_comments: z.boolean().optional().default(true).describe(
          "Include issue comments (default true, up to 50)"
        ),
        include_images: z.boolean().optional().default(true).describe(
          "Fetch and return images embedded in the issue or comments (default true)"
        ),
      }),
    },
    fetchGithubIssueHandler,
  );
}

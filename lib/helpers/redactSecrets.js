// lib/helpers/redactSecrets.js
// PRIVACY-01 — scrub high-confidence credentials out of text before it leaves
// the machine for a *cloud* provider (Anthropic/DeepSeek/Gemini/claude-code).
// Conservative by design: only patterns that are almost never legitimate chat
// content, so normal prose/code is untouched. Each hit becomes [REDACTED:<kind>].
//
// This is a backstop, not a guarantee — it can't catch every secret shape. It
// exists so an API key that lands in a memory, file, or tool output doesn't get
// shipped to a third-party model by accident.

// Ordered: connection-string passwords first (they embed before the generic
// assignment rule could mangle them), then discrete token shapes, then the
// loose key=value rule last.
const RULES = [
  // user:password@host in URIs → keep the URI, drop the password
  {
    kind: "uri-password",
    re: /\b((?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis|amqp|amqps):\/\/[^:/\s]+:)([^@\s]+)@/gi,
    replace: (_m, prefix) => `${prefix}[REDACTED:uri-password]@`,
  },
  // PEM private key blocks
  {
    kind: "private-key",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    replace: () => "[REDACTED:private-key]",
  },
  // JWTs (header.payload.signature, all base64url)
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => "[REDACTED:jwt]",
  },
  // AWS access key id
  { kind: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => "[REDACTED:aws-key]" },
  // Anthropic / OpenAI style keys (sk-ant-… and sk-…)
  { kind: "api-key", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, replace: () => "[REDACTED:api-key]" },
  // GitHub tokens
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, replace: () => "[REDACTED:github-token]" },
  // Google API key
  { kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => "[REDACTED:google-key]" },
  // Slack tokens
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: () => "[REDACTED:slack-token]" },
  // Generic assignment: api_key="…", password: '…', secret=… (value ≥ 6 chars, no spaces)
  {
    kind: "assigned-secret",
    re: /\b(api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret)(["']?\s*[:=]\s*["']?)([^\s"']{6,})/gi,
    replace: (_m, key, sep, _val) => `${key}${sep}[REDACTED:assigned-secret]`,
  },
];

// Redact a single string. Non-strings pass through unchanged.
export function redactSecrets(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const { re, replace } of RULES) out = out.replace(re, replace);
  return out;
}

// Redact the text inside a provider message array without altering structure
// (tool_use / tool_result blocks keep their shape; only human-readable text and
// string content are scrubbed). Returns a new array; inputs are not mutated.
export function redactMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    if (typeof m.content === "string") return { ...m, content: redactSecrets(m.content) };
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((block) =>
          block && typeof block.text === "string"
            ? { ...block, text: redactSecrets(block.text) }
            : block
        ),
      };
    }
    return m;
  });
}

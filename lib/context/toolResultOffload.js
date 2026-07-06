import { decode, encode } from "gpt-tokenizer";
import { redactSecrets } from "../helpers/redactSecrets.js";

const DEFAULT_TOKEN_LIMIT = 20_000;
const DEFAULT_BYTE_LIMIT = 80_000;
const DEFAULT_PREVIEW_TOKENS = 2_000;
const MIN_DYNAMIC_TOKEN_LIMIT = 256;
const MIN_PREVIEW_TOKENS = 16;

function nonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function effectiveTokenLimit(configured, contextWindow) {
  if (configured === 0) return 0;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return configured;
  return Math.min(configured, Math.max(MIN_DYNAMIC_TOKEN_LIMIT, Math.floor(contextWindow * 0.25)));
}

function previewText(text, tokens, limit, toolName, metadata) {
  const previewBudget = Math.max(
    1,
    Math.min(
      DEFAULT_PREVIEW_TOKENS,
      Math.max(MIN_PREVIEW_TOKENS, Math.floor(limit / 2)),
      tokens.length - 1,
    ),
  );
  const headCount = Math.max(1, Math.floor(previewBudget / 3));
  const tailCount = Math.max(0, previewBudget - headCount);
  const head = decode(tokens.slice(0, headCount));
  const tail = tailCount > 0 ? decode(tokens.slice(-tailCount)) : "";
  const omitted = Math.max(0, tokens.length - headCount - tailCount);
  return (
    `${head}\n\n` +
    `… [${omitted} tokens from ${toolName} offloaded outside the model context] …\n` +
    `Artifact: ${metadata.id} · ${metadata.byteCount} bytes · SHA-256 ${metadata.sha256.slice(0, 12)}…\n` +
    `The complete redacted result is preserved. Use the artifact retrieval tool when available; ` +
    `otherwise issue a narrower follow-up query for missing details.\n\n` +
    `${tail}`
  );
}

/**
 * Build a lossless tool-result offloader.
 *
 * The returned function preserves result shape and returns both the model-facing
 * replacement and metadata for any stored text blocks. Storage is redacted
 * before persistence; non-text blocks are never altered.
 */
export function createToolResultOffloader({
  artifactStore,
  tokenLimit = DEFAULT_TOKEN_LIMIT,
  byteLimit = DEFAULT_BYTE_LIMIT,
  redact = redactSecrets,
} = {}) {
  if (!artifactStore?.put) throw new TypeError("artifactStore with put() is required");
  const rawTokenLimit = nonNegativeInt(tokenLimit, DEFAULT_TOKEN_LIMIT);
  const configuredTokenLimit = rawTokenLimit === 0
    ? 0
    : Math.max(MIN_DYNAMIC_TOKEN_LIMIT, rawTokenLimit);
  const configuredByteLimit = nonNegativeInt(byteLimit, DEFAULT_BYTE_LIMIT);

  function offloadText(text, context) {
    if (typeof text !== "string" || !text || text.startsWith("❌")) {
      return { value: text, artifact: null };
    }
    const safeText = redact(text);
    if (typeof safeText !== "string") throw new TypeError("redact must return a string");
    const bytes = Buffer.byteLength(safeText, "utf8");
    const tokens = encode(safeText);
    const limit = effectiveTokenLimit(configuredTokenLimit, context.contextWindow);
    const overTokens = limit > 0 && tokens.length > limit;
    const overBytes = configuredByteLimit > 0 && bytes > configuredByteLimit;
    if (!overTokens && !overBytes) return { value: text, artifact: null };

    const metadata = artifactStore.put({
      scope: context.scope,
      ownerId: context.ownerId,
      sourceTool: context.toolName,
      mediaType: "text/plain; charset=utf-8",
      content: safeText,
    });
    const previewLimit = limit > 0
      ? limit
      : Math.max(MIN_DYNAMIC_TOKEN_LIMIT, Math.min(tokens.length - 1, DEFAULT_PREVIEW_TOKENS * 2));
    return {
      value: previewText(safeText, tokens, previewLimit, context.toolName, metadata),
      artifact: {
        ...metadata,
        originalTokenCount: tokens.length,
      },
    };
  }

  return function offloadToolResult(result, {
    toolName,
    scope,
    ownerId,
    contextWindow = 0,
  }) {
    if (!toolName || !scope || !ownerId) {
      return { result, artifacts: [] };
    }
    const context = { toolName, scope, ownerId, contextWindow };
    if (typeof result === "string") {
      const { value, artifact } = offloadText(result, context);
      return { result: value, artifacts: artifact ? [artifact] : [] };
    }
    if (!Array.isArray(result)) return { result, artifacts: [] };

    const artifacts = [];
    let changed = false;
    const blocks = result.map(block => {
      if (!block || block.type !== "text" || typeof block.text !== "string") return block;
      const { value, artifact } = offloadText(block.text, context);
      if (!artifact) return block;
      changed = true;
      artifacts.push(artifact);
      return { ...block, text: value };
    });
    return { result: changed ? blocks : result, artifacts };
  };
}

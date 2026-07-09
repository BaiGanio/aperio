const DEFAULT_LIMIT = 8_192;
const MAX_CHUNK_BYTES = 24_000;
const MAX_RESPONSE_BYTES = 32_000;

export const ARTIFACT_READ_TOOL_NAME = "read_artifact";

export const ARTIFACT_READ_TOOL = Object.freeze({
  name: ARTIFACT_READ_TOOL_NAME,
  description:
    "Read a byte range from a complete tool result that Aperio offloaded outside the model context. " +
    "Use the artifact ID from the bounded tool-result preview and continue from next_offset until end is true.",
  inputSchema: Object.freeze({
    type: "object",
    properties: {
      artifact_id: {
        type: "string",
        description: "Artifact ID shown in an offloaded tool-result preview.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        default: 0,
        description: "Zero-based byte offset. Use next_offset from the previous response.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_CHUNK_BYTES,
        default: DEFAULT_LIMIT,
        description: `Maximum content bytes to return (up to ${MAX_CHUNK_BYTES}).`,
      },
    },
    required: ["artifact_id"],
    additionalProperties: false,
  }),
});

export function appendArtifactReadTool(tools, providerKind, enabled) {
  if (!enabled) return tools;
  if (providerKind === "mcp") return [...tools, ARTIFACT_READ_TOOL];
  if (providerKind === "anthropic") {
    return [...tools, {
      name: ARTIFACT_READ_TOOL.name,
      description: ARTIFACT_READ_TOOL.description,
      input_schema: ARTIFACT_READ_TOOL.inputSchema,
    }];
  }
  if (providerKind === "openai") {
    return [...tools, {
      type: "function",
      function: {
        name: ARTIFACT_READ_TOOL.name,
        description: ARTIFACT_READ_TOOL.description,
        parameters: ARTIFACT_READ_TOOL.inputSchema,
      },
    }];
  }
  if (providerKind === "gemini") {
    const declarations = tools[0]?.functionDeclarations ?? [];
    return [{
      functionDeclarations: [...declarations, {
        name: ARTIFACT_READ_TOOL.name,
        description: ARTIFACT_READ_TOOL.description,
        parameters: ARTIFACT_READ_TOOL.inputSchema,
      }],
    }];
  }
  throw new TypeError(`Unsupported artifact tool provider kind: ${providerKind}`);
}

function invalid(message) {
  return `❌ Artifact read error: ${message}`;
}

/**
 * Build an owner-bound, read-only artifact tool handler.
 *
 * Ownership is supplied by the agent runtime, never by model-controlled
 * arguments. Missing and foreign IDs deliberately return the same error.
 */
export function createArtifactReader({ artifactStore } = {}) {
  if (!artifactStore?.read) throw new TypeError("artifactStore with read() is required");

  return function readArtifact(args = {}, owner = null) {
    const artifactId = args?.artifact_id;
    const offset = args?.offset ?? 0;
    const limit = args?.limit ?? DEFAULT_LIMIT;
    if (typeof artifactId !== "string" || !artifactId) return invalid("artifact_id is required");
    if (!Number.isSafeInteger(offset) || offset < 0) return invalid("offset must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHUNK_BYTES) {
      return invalid(`limit must be an integer from 1 to ${MAX_CHUNK_BYTES}`);
    }
    if (!owner?.scope || !owner?.ownerId) return invalid("artifact is not available in this run");

    let stored;
    try {
      stored = artifactStore.read({
        scope: owner.scope,
        ownerId: owner.ownerId,
        artifactId,
      });
    } catch {
      // Do not reveal whether validation, metadata, or another owner's artifact
      // caused the miss.
      return invalid("artifact was not found or is not accessible");
    }
    if (!stored) return invalid("artifact was not found or is not accessible");

    const totalBytes = stored.metadata.byteCount;
    if (offset > totalBytes) return invalid(`offset exceeds artifact size (${totalBytes} bytes)`);
    const endOffset = Math.min(totalBytes, offset + limit);
    const content = stored.content.subarray(offset, endOffset).toString("utf8");
    const end = endOffset >= totalBytes;
    const header = [
      `Artifact: ${stored.metadata.id}`,
      `Bytes: ${offset}-${endOffset} of ${totalBytes}`,
      `Next offset: ${endOffset}`,
      `End: ${end}`,
      "",
      "",
    ].join("\n");
    const response = header + content;
    if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
      return invalid("response exceeded the configured maximum size");
    }
    return response;
  };
}

export const ARTIFACT_RETRIEVAL_LIMITS = Object.freeze({
  defaultChunkBytes: DEFAULT_LIMIT,
  maxChunkBytes: MAX_CHUNK_BYTES,
  maxResponseBytes: MAX_RESPONSE_BYTES,
});

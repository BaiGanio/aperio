function formatResult(result) {
  const started = result.targets.filter((entry) => entry.status === "started");
  const active = result.targets.filter((entry) => entry.status === "in_progress");
  const existing = result.targets.filter((entry) => entry.status === "already_indexed");
  const lines = [];
  if (started.length) {
    lines.push(`✅ Indexing started for ${result.path}.`);
    lines.push(`Progress is available in the ${started.map((entry) => entry.panel).join(" and ")} panel${started.length === 1 ? "" : "s"}.`);
  }
  if (active.length) {
    lines.push(`Indexing is already in progress in the ${active.map((entry) => entry.panel).join(" and ")} panel${active.length === 1 ? "" : "s"}.`);
  }
  for (const entry of existing) {
    lines.push(`Already indexed in the ${entry.panel} panel${entry.coveredBy ? ` (covered by ${entry.coveredBy})` : ""}.`);
  }
  return lines.join("\n");
}

export function createIndexFolderTool(folderIndexer) {
  return {
    name: "index_folder",
    description:
      "Start live indexing for a folder already authorized in Allowed Paths and return immediately. " +
      "Use target=code for repositories/codebases, target=documents for notes/PDFs/documents, and target=both only when the user explicitly asks for both. " +
      "If a bare folder request does not reveal which index is intended, ask the user to choose. Progress appears in the corresponding Code Graph or Document Graph panel.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path or ~/ path to an existing directory inside Allowed Paths.",
        },
        target: {
          type: "string",
          enum: ["code", "documents", "both"],
          description: "Which index to populate.",
        },
      },
      required: ["path", "target"],
      additionalProperties: false,
    },
    async handler(args) {
      try {
        return formatResult(await folderIndexer.start(args));
      } catch (err) {
        return `❌ Could not start folder indexing: ${err.message}`;
      }
    },
  };
}

export { formatResult as formatIndexFolderResult };

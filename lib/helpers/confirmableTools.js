// lib/helpers/confirmableTools.js
// Shared canonical list of tools that require user confirmation before execution.
// Both the WS handler (handleConfirmAction) and the HTTP API (decideAndMaybeExecute)
// import from here so the two sites stay in sync.

export const CONFIRMABLE_TOOLS = new Set([
  "create_github_issue", "update_github_issue",
  "delete_file", "write_file", "edit_file", "append_file",
  "db_execute", "index_folder",
  "extraction_template_propose",
]);

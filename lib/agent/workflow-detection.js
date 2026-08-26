// Workflow suggestions intentionally use a positive allowlist. Read-only
// orientation and retrieval calls are useful within a turn, but they are too
// common to constitute a repeatable workflow by themselves.
export const MEANINGFUL_WORKFLOW_TOOLS = new Set([
  "write_file", "edit_file", "append_file", "delete_file",
  "generate_xlsx", "generate_docx",
  "run_shell", "run_node_script", "run_python_script", "syntax_check",
  "wiki_write", "self_wiki_write",
  "db_execute", "import_data", "export_data",
  "create_github_issue", "update_github_issue", "record_issue_triage",
  "preprocess_image",
]);

export function isMeaningfulWorkflowTool(name) {
  return MEANINGFUL_WORKFLOW_TOOLS.has(name);
}

export function buildWorkflowSuggestion(sequence, minimumCalls = 2) {
  if (!Array.isArray(sequence) || sequence.length < minimumCalls) return null;
  return {
    type: "workflow_suggestion",
    tools: sequence.map(({ name, summary }) => ({ name, summary })),
    names: [...new Set(sequence.map(({ name }) => name))],
  };
}

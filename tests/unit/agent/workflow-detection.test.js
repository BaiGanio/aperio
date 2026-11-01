import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkflowSuggestion,
  isMeaningfulWorkflowTool,
} from "../../../lib/agent/workflow-detection.js";

describe("workflow detection", () => {
  test("documents the meaningful tool boundary", () => {
    assert.equal(isMeaningfulWorkflowTool("write_file"), true);
    assert.equal(isMeaningfulWorkflowTool("edit_file"), true);
    assert.equal(isMeaningfulWorkflowTool("run_node_script"), true);
    assert.equal(isMeaningfulWorkflowTool("recall"), false);
    assert.equal(isMeaningfulWorkflowTool("read_file"), false);
    assert.equal(isMeaningfulWorkflowTool("grep_files"), false);
    assert.equal(isMeaningfulWorkflowTool("fetch_url"), false);
  });

  test("emits only after two meaningful successful calls", () => {
    const first = { name: "write_file", summary: "a.js" };
    const second = { name: "syntax_check", summary: "a.js" };

    assert.equal(buildWorkflowSuggestion([]), null);
    assert.equal(buildWorkflowSuggestion([first]), null);
    assert.deepEqual(buildWorkflowSuggestion([first, second]), {
      type: "workflow_suggestion",
      tools: [first, second],
      names: ["write_file", "syntax_check"],
    });
  });

  test("preserves repeated meaningful calls while deduplicating display names", () => {
    const calls = [
      { name: "edit_file", summary: "a.js" },
      { name: "edit_file", summary: "b.js" },
    ];
    const suggestion = buildWorkflowSuggestion(calls);
    assert.equal(suggestion.tools.length, 2);
    assert.deepEqual(suggestion.names, ["edit_file"]);
  });
});

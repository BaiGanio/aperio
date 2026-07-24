import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runWithPaths } from "../../../lib/routes/paths.js";
import { generateXlsxHandler } from "../../../mcp/tools/files/generate.js";

const created = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("generated file ownership", () => {
  test("generate_xlsx writes into active session scratch and reports its exact path", async () => {
    const root = await mkdtemp(join(tmpdir(), "aperio-generate-"));
    created.push(root);
    const scratch = join(root, "session-123");

    const result = await runWithPaths([root], [root], scratch, () => generateXlsxHandler({
      filename: "trash/requested/report.xlsx",
      sheets: [{ name: "Data", headers: ["Value"], rows: [[42]] }],
    }));

    const text = result.content[0].text;
    assert.ok(text.startsWith("APERIO_FILE:"));
    const artifact = JSON.parse(text.slice("APERIO_FILE:".length));
    assert.match(artifact.path, new RegExp(`^${scratch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`));
    assert.match(artifact.url, /^\/scratch\/session-123\//);
    assert.equal(artifact.filename, "report.xlsx");
    assert.ok((await stat(artifact.path)).isFile());
    assert.ok(!artifact.path.includes("/var/uploads/"));
  });

  test("standalone generation uses an isolated mcp run workspace, never uploads", async () => {
    const root = await mkdtemp(join(tmpdir(), "aperio-mcp-generate-"));
    created.push(root);
    const moduleUrl = pathToFileURL(join(process.cwd(), "mcp/tools/files/generate.js")).href;
    const script = `
      import { generateXlsxHandler } from ${JSON.stringify(moduleUrl)};
      const result = await generateXlsxHandler({ filename: "report.xlsx", sheets: [{ name: "Data", headers: ["A"], rows: [[1]] }] });
      process.stdout.write(result.content[0].text);
    `;
    const output = await new Promise((resolveOutput, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolveOutput(stdout) : reject(new Error(stderr)));
    });

    const artifact = JSON.parse(output.slice("APERIO_FILE:".length));
    assert.match(artifact.path, /\/var\/scratch\/mcp-[^/]+\/[^/]+\.xlsx$/);
    assert.match(artifact.url, /^\/scratch\/mcp-[^/]+\//);
    assert.ok(!artifact.path.includes("/var/uploads/"));
    assert.ok((await stat(artifact.path)).isFile());
  });
});

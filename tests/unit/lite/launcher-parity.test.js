import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const launchers = [
  ".github/lite/assets/start.ps1",
  ".github/lite/assets/launch-hidden.ps1",
];

const expected = new Map([
  ["AI_PROVIDER", "llamacpp"],
  ["PORT", "31337"],
  ["DB_BACKEND", "sqlite"],
  ["EMBEDDING_PROVIDER", "transformers"],
  ["IDLE_SHUTDOWN", "on"],
  ["APERIO_LITE", "on"],
  ["APERIO_CONFIG_PRECEDENCE", "db"],
]);

function launcherEnv(source) {
  return new Map([...source.matchAll(/^\$env:([A-Z0-9_]+)\s*=\s*'([^']+)'/gm)].map(([, key, value]) => [key, value]));
}

test("Windows lite launchers match start:lite's seven environment variables", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  for (const [key, value] of expected) {
    assert.match(pkg.scripts["start:lite"], new RegExp(`(?:^| )${key}=${value}(?: |$)`));
  }
  for (const file of launchers) {
    const source = readFileSync(file, "utf8");
    assert.deepEqual(launcherEnv(source), expected, file);
    assert.match(source, /package\.json[^\n]*start:lite|start:lite[^\n]*source of truth/i, `${file} source-of-truth comment`);
  }
});

test("Windows lite launchers parse as PowerShell", { skip: spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" }).error ? "pwsh unavailable; defer to Windows CI" : false }, () => {
  for (const file of launchers) {
    const command = `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$errors) > $null; if ($errors.Count) { $errors | Out-String; exit 1 }`;
    const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout || result.stderr);
  }
});

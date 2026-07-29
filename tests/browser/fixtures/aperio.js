import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import { startRealApp } from "../../e2e/helpers/real-app-helper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fixtureLog(app) {
  return [
    `pid=${app.pid}`,
    `port=${app.port}`,
    `runtimeRoot=${app.runtimeRoot}`,
    "",
    "=== stdout ===",
    ...app.stdout,
    "",
    "=== stderr ===",
    ...app.stderr,
  ].join("\n");
}

export const test = base.extend({
  aperio: [async ({}, use) => {
    const app = await startRealApp(null, {
      readyTimeout: 25_000,
      prepareRuntime(runtimeRoot) {
        const varDir = resolve(runtimeRoot, "var");
        mkdirSync(varDir, { recursive: true });
        writeFileSync(resolve(varDir, "pricing-cache.json"), JSON.stringify({
          fetchedAt: Date.now(),
          models: {},
        }));
      },
      env: {
        APERIO_E2E_SKIP_BOOT: "0",
        APERIO_E2E_INJECT_AGENT: "1",
        AI_PROVIDER: "stub",
        EMBEDDING_PROVIDER: "none",
        DB_BACKEND: "sqlite",
        SQLITE_PATH: "aperio-browser.db",
        APERIO_CODEGRAPH: "off",
        APERIO_DOCGRAPH: "off",
        IDLE_SHUTDOWN: "off",
        APERIO_CONFIG_PRECEDENCE: "env",
        APERIO_AGENT_JOBS: "on",
        APERIO_LITE: "off",
        APERIO_AUTH_TOKEN: "",
      },
    });

    try {
      const runtimeRoot = realpathSync(app.runtimeRoot);
      const repoRoot = realpathSync(REPO_ROOT);
      if (runtimeRoot === repoRoot || runtimeRoot.startsWith(`${repoRoot}/`)) {
        throw new Error(`Browser fixture runtime is not isolated: ${runtimeRoot}`);
      }
      if (realpathSync(app.bootingData?.cwd) !== runtimeRoot ||
          realpathSync(app.readyData?.runtimeRoot) !== runtimeRoot) {
        throw new Error("Browser fixture did not boot from its temporary runtime");
      }
    } catch (err) {
      await app.stop().catch(() => {});
      throw err;
    }

    try {
      await use({
        ...app,
        baseURL: `http://127.0.0.1:${app.port}`,
        logs: () => fixtureLog(app),
      });
    } finally {
      const exitedBeforeTeardown = !processExists(app.pid);
      let cleanupError;
      try {
        await app.stop();
      } catch (err) {
        cleanupError = err;
      }
      const leakedProcess = processExists(app.pid);
      const retainedRuntime = existsSync(app.runtimeRoot);
      if (exitedBeforeTeardown || cleanupError || leakedProcess || retainedRuntime) {
        throw new Error([
          exitedBeforeTeardown ? `Fixture process ${app.pid} exited unexpectedly` : "",
          cleanupError ? `Fixture cleanup failed: ${cleanupError.message}` : "",
          leakedProcess ? `Fixture process ${app.pid} remained after teardown` : "",
          retainedRuntime ? `Fixture runtime remained after teardown: ${app.runtimeRoot}` : "",
          fixtureLog(app),
        ].filter(Boolean).join("\n"));
      }
    }
  }, { scope: "worker", timeout: 30_000 }],

  baseURL: async ({ aperio }, use) => {
    await use(aperio.baseURL);
  },

  browserDiagnostics: [async ({ page, aperio }, use, testInfo) => {
    const pageErrors = [];
    const consoleErrors = [];
    const allowedConsoleErrors = [];
    const onPageError = error => pageErrors.push(error.stack || error.message);
    const onConsole = message => {
      if (message.type() === "error") consoleErrors.push(message.text());
    };
    page.on("pageerror", onPageError);
    page.on("console", onConsole);

    await use({
      pageErrors,
      consoleErrors,
      allowConsole(pattern) {
        allowedConsoleErrors.push(pattern);
      },
    });

    page.off("pageerror", onPageError);
    page.off("console", onConsole);
    const unexpectedConsoleErrors = consoleErrors.filter(message =>
      !allowedConsoleErrors.some(pattern => pattern.test(message))
    );
    const diagnostics = [
      pageErrors.length ? `=== page errors ===\n${pageErrors.join("\n")}` : "",
      consoleErrors.length ? `=== console errors ===\n${consoleErrors.join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    const failed = testInfo.status !== testInfo.expectedStatus ||
      pageErrors.length > 0 || unexpectedConsoleErrors.length > 0;

    if (failed) {
      const logPath = testInfo.outputPath("aperio-fixture.log");
      writeFileSync(logPath, aperio.logs());
      await testInfo.attach("aperio-fixture-log", {
        path: logPath,
        contentType: "text/plain",
      });
      await testInfo.attach("browser-errors", {
        body: Buffer.from(diagnostics || "No pageerror or console.error messages captured."),
        contentType: "text/plain",
      });
    }

    if (pageErrors.length || unexpectedConsoleErrors.length) {
      throw new Error(diagnostics);
    }
  }, { auto: true }],
});

export { expect };

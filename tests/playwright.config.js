import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const localWorkers = Number.parseInt(process.env.PLAYWRIGHT_WORKERS || "", 10);
const ROOT = resolve(import.meta.dirname, "..");
const browserJsonReporter = resolve(ROOT, "tests/reporters/browser-json.js");
const browserResults = resolve(ROOT, "tests/results/browser-results.json");

export default defineConfig({
  testDir: resolve(ROOT, "tests/browser"),
  outputDir: resolve(ROOT, "test-results/playwright"),
  fullyParallel: true,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  workers: process.env.CI ? 1 : (localWorkers > 0 ? localWorkers : 1),
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [
        ["github"],
        ["line"],
        [browserJsonReporter, { outputFile: browserResults }],
        ["html", { outputFolder: resolve(ROOT, "playwright"), open: "never" }],
      ]
    : [
        ["line"],
        [browserJsonReporter, { outputFile: browserResults }],
        ["html", { outputFolder: resolve(ROOT, "playwright"), open: "never" }],
      ],
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

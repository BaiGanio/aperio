// Combined unit + integration reporter for coverage CI.
// Keeping both dashboard payloads behind one node:test reporter avoids the
// TestsStream listener warning caused by composing three reporter pipelines.

import { Transform } from "node:stream";

import { createIntegrationReporter } from "./integration-json.js";
import { createUnitReporter } from "./unit-json.js";

export function createCIReporter() {
  const unit = capture(createUnitReporter());
  const integration = capture(createIntegrationReporter());

  return new Transform({
    writableObjectMode: true,
    readableObjectMode: false,

    transform(event, encoding, callback) {
      unit.reporter.write(event, encoding);
      integration.reporter.write(event, encoding);
      callback();
    },

    flush(callback) {
      Promise.all([finish(unit), finish(integration)])
        .then(([unitResult, integrationResult]) => {
          this.push(JSON.stringify({
            generatedAt: new Date().toISOString(),
            unit: unitResult,
            integration: integrationResult,
          }));
          callback();
        }, callback);
    },
  });
}

function capture(reporter) {
  let output = "";
  reporter.on("data", (chunk) => { output += chunk.toString(); });
  return { reporter, output: () => output };
}

function finish(captured) {
  return new Promise((resolve, reject) => {
    captured.reporter.once("end", () => {
      try {
        resolve(JSON.parse(captured.output()));
      } catch (err) {
        reject(err);
      }
    });
    captured.reporter.once("error", reject);
    captured.reporter.end();
  });
}

export default createCIReporter;

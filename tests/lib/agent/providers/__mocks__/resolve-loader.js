// Loader hook to redirect @anthropic-ai/claude-agent-sdk to the mock.
// Used via module.register() in the test setup.

import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const MOCK_PATH = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "claude-agent-sdk.js"
);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@anthropic-ai/claude-agent-sdk") {
    return {
      shortCircuit: true,
      url: new URL(`file://${MOCK_PATH}`).href,
    };
  }
  return nextResolve(specifier, context);
}

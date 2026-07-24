import { query } from "@anthropic-ai/claude-agent-sdk";

const sdk = await import("@anthropic-ai/claude-agent-sdk");
console.log("query === sdk.query:", query === sdk.query);

const desc = Object.getOwnPropertyDescriptor(sdk, "query");
console.log("configurable:", desc.configurable);

try {
  Object.defineProperty(sdk, "query", { value: () => "mocked" });
  console.log("defineProperty succeeded");
} catch (e) {
  console.log("defineProperty failed:", e.message);
}

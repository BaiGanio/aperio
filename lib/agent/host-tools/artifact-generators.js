import { generateDocxHandler, generateXlsxHandler } from "../../../mcp/tools/files/generate.js";

// These handlers must run in the agent host process so AsyncLocalStorage can
// bind their output to the current session scratch workspace. `override` keeps
// the MCP-advertised schemas and replaces only execution.
export function createArtifactGeneratorTools() {
  const asHostResult = handler => async args => {
    const result = await handler(args);
    return result?.content?.find(block => block.type === "text")?.text ?? "No result";
  };
  return [
    { name: "generate_xlsx", override: true, handler: asHostResult(generateXlsxHandler) },
    { name: "generate_docx", override: true, handler: asHostResult(generateDocxHandler) },
  ];
}

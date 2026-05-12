import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { loadSkillIndex, matchSkill } from "../workers/skills.js";
import { resolveReasoningAdapter } from "../workers/reasoning.js";
import logger from "../helpers/logger.js";
import { resolveProvider, getRecommendedModel } from "../providers/index.js";
import { zodToJsonSchema } from "../providers/schema.js";
import { runAnthropicLoop } from "./providers/anthropic.js";
import { runOllamaLoop } from "./providers/ollama.js";

export { getRecommendedModel, resolveProvider, zodToJsonSchema };

export function parseMemoriesRaw(raw) {
  if (!raw || raw.trim() === "No memories found." || raw.trim() === "No result") return [];
  return raw.split("---").filter(b => b.trim()).map(block => {
    const lines = block.trim().split("\n");
    const header = lines[0] || "";
    const typeMatch = header.match(/\[(\w+)\]/);
    const titleMatch = header.match(/\] (.+?) \(importance:/) || header.match(/\] (.+)/);
    const importanceMatch = header.match(/importance: (\d)/);
    const contentLine = lines[1] || "";
    const tagsLine = lines.find(l => l.startsWith("Tags:")) || "";
    const tags = tagsLine.replace("Tags:", "").trim().split(",").map(t => t.trim()).filter(Boolean);
    const idLine = lines.find(l => l.startsWith("ID:")) || "";
    const id = idLine.replace("ID:", "").trim() || null;
    const dateLine = lines.find(l => l.startsWith("Created:") || l.startsWith("Saved:")) || "";
    const createdAt = dateLine.split(":").slice(1).join(":").trim() || null;
    const type = typeMatch?.[1]?.toLowerCase() || "fact";
    const title = titleMatch?.[1] || "Untitled";
    return { type, title, content: contentLine, tags: tags[0] === "none" ? [] : tags, importance: Number.parseInt(importanceMatch?.[1] || "3"), id, createdAt };
  });
}

export async function createAgent({ root, version, clientName = "Aperio-agent" }) {
  const provider = resolveProvider();
  const reasoningAdapter = resolveReasoningAdapter(provider.model);
  const state = { thinks: reasoningAdapter.thinks === true, noTools: reasoningAdapter.noTools === true };
  logger.info(`[agent] model="${provider.model}" adapter="${reasoningAdapter.match}" thinks=${state.thinks} noTools=${state.noTools}`);

  const FILES = ["whoami.md"];
  const CACHED_PROMPT = FILES.map(f => { try { return readFileSync(resolve(root, "id", f), "utf-8"); } catch { return ""; } }).join("\n\n");
  const skillIndex = loadSkillIndex(resolve(root, "skills"));
  const providerTag = `---\nYou are running as: ${provider.name === "ollama" ? `Ollama (${provider.model})` : provider.name === "deepseek" ? `DeepSeek (${provider.model})` : `Anthropic Claude (${provider.model})`}\nIf asked which model or AI you are, answer accurately using the above.`;

  const LANG_NAMES = {
    en: "English", bg: "Bulgarian", de: "German", fr: "French", es: "Spanish",
    it: "Italian", pt: "Portuguese", nl: "Dutch", pl: "Polish", ro: "Romanian",
    el: "Greek", sv: "Swedish", da: "Danish", fi: "Finnish", cs: "Czech",
    sk: "Slovak", sl: "Slovenian", hr: "Croatian", hu: "Hungarian", et: "Estonian",
    lv: "Latvian", lt: "Lithuanian", mt: "Maltese", ga: "Irish",
  };
  function buildLanguageDirective(lang) {
    const name = LANG_NAMES[lang];
    if (!name || lang === "en") return null;
    return `LANGUAGE DIRECTIVE — highest priority, overrides all other instructions:\n` +
      `The user's interface language is ${name} (${lang}). ` +
      `You MUST think and reason in ${name}. Do NOT use English in your reasoning chain — think in ${name} from the first token. ` +
      `Respond to the user in ${name} using natural, native phrasing. ` +
      `Exception: if the user explicitly writes in a different language, mirror that language for both thinking and response. ` +
      `Keep code, identifiers, file paths, CLI snippets, and proper names in their original form.`;
  }

  const getSystemPrompt = (userMessage = "", lang = "en", extraSystem = "") => {
    const langDirective = buildLanguageDirective(lang);
    const parts = langDirective ? [langDirective, CACHED_PROMPT] : [CACHED_PROMPT];
    const onDemand = matchSkill(userMessage, skillIndex);
    if (onDemand) { logger.info(`🎯 Skill matched: ${onDemand.name}`); parts.push(onDemand.content); }
    parts.push(providerTag);
    if (extraSystem) parts.push(extraSystem);
    return parts.join("\n\n---\n\n");
  };

  const transport = new StdioClientTransport({ command: "node", args: [resolve(root, "mcp/index.js")], env: { ...process.env } });
  const mcp = new Client({ name: clientName, version });
  await mcp.connect(transport);
  const { tools: mcpTools } = await mcp.listTools();
  const anthropicTools = mcpTools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const ollamaTools = mcpTools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: zodToJsonSchema(t.inputSchema) } }));

  async function callTool(name, input) {
    const args = input?.parameters !== undefined ? input.parameters : (input ?? {});
    const result = await mcp.callTool({ name, arguments: args });
    const text = result.content?.find(c => c.type === "text")?.text ?? "";
    const image = result.content?.find(c => c.type === "image");
    if (image) {
      return `[Image data: ${image.data ? `base64 (${Math.round(image.data.length * 0.75 / 1024)}KB)` : "no data"}] ${text}`;
    }
    return text || "No result";
  }

  const ctx = { provider, callTool, getSystemPrompt, anthropicTools, ollamaTools, reasoningAdapter, state };

  return {
    provider, mcpTools,
    get OLLAMA_THINKS() { return state.thinks; },
    OLLAMA_NO_TOOLS: state.noTools, reasoningAdapter, callTool,
    async runAgentLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}) {
      return provider.name === "anthropic"
        ? runAnthropicLoop(messages, emitter, opts, ctx)
        : runOllamaLoop(messages, emitter, opts, getAbort, setAbort, ctx);
    },
    async handleRememberIntent(text, emitter) {
      try { const content = text.replace(/^remember\s+that\s*/i, "").trim(); await callTool("remember", { type: "preference", title: content.substring(0, 60), content }); emitter.send({ type: "tool", name: "remember" }); }
      catch (err) { logger.error("handleRememberIntent failed:", err.message); }
    },
    async fetchMemories() { const raw = await callTool("recall", { limit: 50 }); return { raw, parsed: parseMemoriesRaw(raw) }; },
    async buildGreeting(lang = "en") {
      let ctx = "";
      try { const raw = await callTool("recall", { limit: 50 }); if (raw && raw.trim() && !raw.includes("No memories")) ctx = `\n\nHere is what you know about the user:\n${raw}`; } catch {}
      let greetingPrompt = "Greet me in one short friendly sentence. Do not use any tools.";
      try {
        const localeFile = resolve(root, "public/locales", `${lang}.json`);
        const locale = JSON.parse(readFileSync(localeFile, "utf-8"));
        if (locale.agent_greeting) greetingPrompt = locale.agent_greeting;
      } catch { /* fall back to English */ }
      return `${greetingPrompt}${ctx}`;
    },
  };
}

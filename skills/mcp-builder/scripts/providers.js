import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

class AnthropicProvider {
  defaultModel = "claude-sonnet-4-6";

  constructor(apiKey) {
    this.client = new Anthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY });
  }

  async chat(model, messages, tools, system) {
    return this.client.messages.create({ model, max_tokens: 4096, system, messages, tools });
  }

  isToolUse(response) {
    return response.stop_reason === "tool_use";
  }

  getToolCalls(response) {
    return response.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
  }

  getTextContent(response) {
    return response.content.find((b) => b.type === "text")?.text ?? null;
  }

  appendAssistantMessage(messages, response) {
    messages.push({ role: "assistant", content: response.content });
  }

  appendToolResults(messages, results) {
    messages.push({
      role: "user",
      content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content })),
    });
  }

  formatTools(tools) {
    return tools; // MCP tool format matches Anthropic's directly
  }
}

class OpenAICompatProvider {
  defaultModel = null; // provider-specific, set in subclass or factory

  constructor(baseURL, apiKey) {
    this.client = new OpenAI({ baseURL, apiKey: apiKey || "placeholder" });
  }

  async chat(model, messages, tools, system) {
    const fullMessages = system
      ? [{ role: "system", content: system }, ...messages]
      : messages;
    return this.client.chat.completions.create({
      model,
      max_tokens: 4096,
      messages: fullMessages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? "auto" : undefined,
    });
  }

  isToolUse(response) {
    return response.choices[0].finish_reason === "tool_calls";
  }

  getToolCalls(response) {
    return (response.choices[0].message.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: this._parseArgs(tc.function.arguments),
    }));
  }

  _parseArgs(args) {
    if (typeof args === "string") {
      try { return JSON.parse(args); } catch { return {}; }
    }
    return args ?? {};
  }

  getTextContent(response) {
    return response.choices[0].message.content ?? null;
  }

  appendAssistantMessage(messages, response) {
    messages.push(response.choices[0].message);
  }

  appendToolResults(messages, results) {
    for (const r of results) {
      messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
  }

  formatTools(tools) {
    return tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
}

const PRESETS = {
  anthropic: (apiKey) => {
    const p = new AnthropicProvider(apiKey);
    return p;
  },
  deepseek: (apiKey) => {
    const p = new OpenAICompatProvider(
      "https://api.deepseek.com",
      apiKey || process.env.DEEPSEEK_API_KEY
    );
    p.defaultModel = "deepseek-chat";
    return p;
  },
  ollama: (apiKey) => {
    const p = new OpenAICompatProvider("http://localhost:11434/v1", "ollama");
    return p;
  },
  openai: (apiKey) => {
    const p = new OpenAICompatProvider(
      "https://api.openai.com/v1",
      apiKey || process.env.OPENAI_API_KEY
    );
    p.defaultModel = "gpt-4o";
    return p;
  },
};

export function createProvider({ provider = "anthropic", baseUrl, apiKey }) {
  if (baseUrl) {
    const p = new OpenAICompatProvider(baseUrl, apiKey);
    return p;
  }
  const factory = PRESETS[provider];
  if (!factory) {
    throw new Error(
      `Unknown provider: ${provider}. Use: ${Object.keys(PRESETS).join(", ")}, or --base-url`
    );
  }
  return factory(apiKey);
}

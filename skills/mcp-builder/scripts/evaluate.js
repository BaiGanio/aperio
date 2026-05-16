#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createConnection } from "./connections.js";
import { createProvider } from "./providers.js";

const EVALUATION_PROMPT = `You are an AI assistant with access to tools.

When given a task, you MUST:
1. Use the available tools to complete the task
2. Provide summary of each step in your approach, wrapped in <summary> tags
3. Provide feedback on the tools provided, wrapped in <feedback> tags
4. Provide your final response, wrapped in <response> tags

Summary Requirements:
- In your <summary> tags, you must explain:
  - The steps you took to complete the task
  - Which tools you used, in what order, and why
  - The inputs you provided to each tool
  - The outputs you received from each tool
  - A summary for how you arrived at the response

Feedback Requirements:
- In your <feedback> tags, provide constructive feedback on the tools:
  - Comment on tool names: Are they clear and descriptive?
  - Comment on input parameters: Are they well-documented? Are required vs optional parameters clear?
  - Comment on descriptions: Do they accurately describe what the tool does?
  - Comment on any errors encountered during tool usage
  - Identify specific areas for improvement and explain WHY they would help
  - Be specific and actionable in your suggestions

Response Requirements:
- Your response should be concise and directly address what was asked
- Always wrap your final response in <response> tags
- If you cannot solve the task return <response>NOT_FOUND</response>
- For numeric responses, provide just the number
- For IDs, provide just the ID
- For names or text, provide the exact text requested
- Your response should go last`;

function parseEvaluationFile(filePath) {
  const xml = readFileSync(filePath, "utf8");
  const pairs = [];
  const pairRegex = /<qa_pair>([\s\S]*?)<\/qa_pair>/g;
  let match;
  while ((match = pairRegex.exec(xml)) !== null) {
    const content = match[1];
    const q = /<question>([\s\S]*?)<\/question>/.exec(content);
    const a = /<answer>([\s\S]*?)<\/answer>/.exec(content);
    if (q && a) pairs.push({ question: q[1].trim(), answer: a[1].trim() });
  }
  return pairs;
}

function extractTag(text, tag) {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  let last = null;
  let m;
  while ((m = regex.exec(text)) !== null) last = m[1].trim();
  return last;
}

async function agentLoop(provider, model, question, tools, connection) {
  const messages = [{ role: "user", content: question }];
  const formattedTools = provider.formatTools(tools);
  const toolMetrics = {};

  let response = await provider.chat(model, messages, formattedTools, EVALUATION_PROMPT);
  provider.appendAssistantMessage(messages, response);

  while (provider.isToolUse(response)) {
    const toolCalls = provider.getToolCalls(response);
    const toolResults = [];

    for (const { id, name, input } of toolCalls) {
      const t0 = Date.now();
      let content;
      try {
        const raw = await connection.callTool(name, input);
        content = typeof raw === "string" ? raw : JSON.stringify(raw);
      } catch (e) {
        content = `Error executing tool ${name}: ${e.message}`;
      }
      const duration = (Date.now() - t0) / 1000;

      if (!toolMetrics[name]) toolMetrics[name] = { count: 0, durations: [] };
      toolMetrics[name].count++;
      toolMetrics[name].durations.push(duration);
      toolResults.push({ id, content });
    }

    provider.appendToolResults(messages, toolResults);
    response = await provider.chat(model, messages, formattedTools, EVALUATION_PROMPT);
    provider.appendAssistantMessage(messages, response);
  }

  return { responseText: provider.getTextContent(response), toolMetrics };
}

async function evaluateTask(provider, model, qaPair, tools, connection, index) {
  const t0 = Date.now();
  console.log(`Task ${index + 1}: ${qaPair.question}`);

  const { responseText, toolMetrics } = await agentLoop(
    provider,
    model,
    qaPair.question,
    tools,
    connection
  );

  const actual = extractTag(responseText, "response");
  const numToolCalls = Object.values(toolMetrics).reduce((s, m) => s + m.durations.length, 0);

  return {
    question: qaPair.question,
    expected: qaPair.answer,
    actual,
    score: actual === qaPair.answer ? 1 : 0,
    total_duration: (Date.now() - t0) / 1000,
    tool_calls: toolMetrics,
    num_tool_calls: numToolCalls,
    summary: extractTag(responseText, "summary"),
    feedback: extractTag(responseText, "feedback"),
  };
}

function buildReport(qaPairs, results) {
  const correct = results.reduce((s, r) => s + r.score, 0);
  const total = results.length;
  const avgDuration = total ? results.reduce((s, r) => s + r.total_duration, 0) / total : 0;
  const totalToolCalls = results.reduce((s, r) => s + r.num_tool_calls, 0);
  const avgToolCalls = total ? totalToolCalls / total : 0;

  let report = `# Evaluation Report

## Summary

- **Accuracy**: ${correct}/${total} (${total ? ((correct / total) * 100).toFixed(1) : 0}%)
- **Average Task Duration**: ${avgDuration.toFixed(2)}s
- **Average Tool Calls per Task**: ${avgToolCalls.toFixed(2)}
- **Total Tool Calls**: ${totalToolCalls}

---
`;

  results.forEach((result, i) => {
    report += `
### Task ${i + 1}

**Question**: ${qaPairs[i].question}
**Ground Truth Answer**: \`${qaPairs[i].answer}\`
**Actual Answer**: \`${result.actual ?? "N/A"}\`
**Correct**: ${result.score ? "✅" : "❌"}
**Duration**: ${result.total_duration.toFixed(2)}s
**Tool Calls**: ${JSON.stringify(result.tool_calls, null, 2)}

**Summary**
${result.summary ?? "N/A"}

**Feedback**
${result.feedback ?? "N/A"}

---
`;
  });

  return report;
}

async function runEvaluation(evalPath, provider, model, connection) {
  console.log("Starting Evaluation");

  const tools = await connection.listTools();
  console.log(`Loaded ${tools.length} tools from MCP server`);

  const qaPairs = parseEvaluationFile(evalPath);
  console.log(`Loaded ${qaPairs.length} evaluation tasks`);

  const results = [];
  for (let i = 0; i < qaPairs.length; i++) {
    console.log(`Processing task ${i + 1}/${qaPairs.length}`);
    results.push(await evaluateTask(provider, model, qaPairs[i], tools, connection, i));
  }

  return buildReport(qaPairs, results);
}

// --- CLI ---

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    provider: "anthropic",
    baseUrl: null,
    apiKey: null,
    model: null,
    transport: "stdio",
    command: null,
    cmdArgs: [],
    env: {},
    url: null,
    headers: {},
    output: null,
    evalFile: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--provider") opts.provider = args[++i];
    else if (a === "--base-url") opts.baseUrl = args[++i];
    else if (a === "--api-key") opts.apiKey = args[++i];
    else if (a === "-m" || a === "--model") opts.model = args[++i];
    else if (a === "-t" || a === "--transport") opts.transport = args[++i];
    else if (a === "-c" || a === "--command") opts.command = args[++i];
    else if (a === "-a" || a === "--args") opts.cmdArgs.push(args[++i]);
    else if (a === "-e" || a === "--env") {
      const kv = args[++i];
      const sep = kv.indexOf("=");
      if (sep !== -1) opts.env[kv.slice(0, sep)] = kv.slice(sep + 1);
    } else if (a === "-u" || a === "--url") opts.url = args[++i];
    else if (a === "-H" || a === "--header") {
      const hdr = args[++i];
      const sep = hdr.indexOf(":");
      if (sep !== -1) opts.headers[hdr.slice(0, sep).trim()] = hdr.slice(sep + 1).trim();
    } else if (a === "-o" || a === "--output") opts.output = args[++i];
    else if (!a.startsWith("-")) opts.evalFile = a;
  }

  return opts;
}

function printUsage() {
  console.log(`Usage: node evaluate.js [options] eval_file

Provider options:
  --provider <name>    anthropic (default), deepseek, ollama, openai
  --base-url <url>     Custom OpenAI-compatible API base URL
  --api-key <key>      API key (falls back to env: ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY)
  -m, --model <model>  Model name (defaults: anthropic=claude-sonnet-4-6, deepseek=deepseek-chat, openai=gpt-4o)

MCP transport options:
  -t, --transport      stdio (default), sse, or http
  -o, --output         Output file for report (default: stdout)

stdio options:
  -c, --command        Command to run MCP server (e.g., node)
  -a, --args           Argument for the command (repeat for multiple: -a arg1 -a arg2)
  -e, --env            Environment variable in KEY=VALUE format (repeat for multiple)

sse/http options:
  -u, --url            MCP server URL
  -H, --header         HTTP headers in 'Key: Value' format

Examples:
  # Anthropic (default)
  node evaluate.js -t stdio -c node -a server.js eval.xml

  # DeepSeek v4
  node evaluate.js --provider deepseek --model deepseek-chat -t stdio -c node -a server.js eval.xml

  # Ollama (local)
  node evaluate.js --provider ollama --model gemma4 -t stdio -c node -a server.js eval.xml

  # Custom OpenAI-compatible endpoint
  node evaluate.js --base-url http://localhost:8080/v1 --model my-model -t http -u http://localhost:3000/mcp eval.xml
`);
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.evalFile) {
    printUsage();
    process.exit(1);
  }

  if (!existsSync(opts.evalFile)) {
    console.error(`Error: Evaluation file not found: ${opts.evalFile}`);
    process.exit(1);
  }

  let provider;
  try {
    provider = createProvider({ provider: opts.provider, baseUrl: opts.baseUrl, apiKey: opts.apiKey });
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  const model = opts.model || provider.defaultModel;
  if (!model) {
    console.error(`Error: --model is required for provider "${opts.provider}" (or --base-url)`);
    process.exit(1);
  }

  let connection;
  try {
    connection = createConnection({
      transport: opts.transport,
      command: opts.command,
      args: opts.cmdArgs,
      env: opts.env,
      url: opts.url,
      headers: opts.headers,
    });
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  console.log(`Provider: ${opts.baseUrl ? opts.baseUrl : opts.provider} | Model: ${model}`);
  console.log(`Connecting to MCP server via ${opts.transport}...`);

  try {
    await connection.connect();
    console.log("Connected successfully");

    const report = await runEvaluation(opts.evalFile, provider, model, connection);

    if (opts.output) {
      writeFileSync(opts.output, report, "utf8");
      console.log(`\nReport saved to ${opts.output}`);
    } else {
      console.log("\n" + report);
    }
  } finally {
    await connection.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

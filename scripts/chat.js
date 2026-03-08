import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "fs";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import dotenv from "dotenv";

// ─── Load .env ────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

// ─── Load system prompt ───────────────────────────────────────────────────────
const systemPrompt = readFileSync(
  resolve(__dirname, "../prompts/system_prompt.md"),
  "utf-8"
);

// ─── Anthropic client ─────────────────────────────────────────────────────────
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── MCP server config ────────────────────────────────────────────────────────
const mcpConfig = {
  command: "node",
  args: [resolve(__dirname, "../mcp/index.js")],
};

// ─── Terminal chat interface ──────────────────────────────────────────────────
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const question = (prompt) =>
  new Promise((resolve) => rl.question(prompt, resolve));

// ─── Main chat loop ───────────────────────────────────────────────────────────
async function chat() {
  console.log("\n🧠 Aperio Chat");
  console.log("─────────────────────────────────────");
  console.log("Your AI assistant with persistent memory");
  console.log('Type "exit" to quit\n');

  const messages = [];

  // Initial recall — load core context silently
  messages.push({
    role: "user",
    content: "Hello! Please load my core context from Aperio and then greet me briefly.",
  });

  while (true) {
    const userInput = messages[messages.length - 1].role === "user"
      ? null  // already have a message queued
      : await question("You: ");

    if (userInput === "exit") {
      console.log("\nGoodbye! Your memories are safe in Aperio. 🧠");
      rl.close();
      break;
    }

    if (userInput !== null) {
      messages.push({ role: "user", content: userInput });
    }

    try {
      // Call Claude with MCP server attached
      const response = await client.beta.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        mcp_servers: [
          {
            type: "stdio",
            ...mcpConfig,
            name: "aperio",
          },
        ],
        betas: ["mcp-client-2025-04-04"],
      });

      // Extract text response
      const assistantMessage = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      console.log(`\nClaude: ${assistantMessage}\n`);

      // Add assistant response to history
      messages.push({
        role: "assistant",
        content: response.content,
      });

      // Check if Claude is suggesting memories to store
      if (assistantMessage.includes("🧠 **Memory suggestions**")) {
        const answer = await question("Your choice (numbers or 'none'): ");

        if (answer.toLowerCase() !== "none" && answer.trim() !== "") {
          messages.push({
            role: "user",
            content: `Please save memory suggestions: ${answer}`,
          });
          continue; // loop back to process the save
        }
      }

    } catch (err) {
      console.error("❌ Error:", err.message);
    }
  }
}

chat();

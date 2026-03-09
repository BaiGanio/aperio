import { WebSocket } from "ws";
import { createInterface } from "readline";

const PORT = process.env.PORT || 3000;
const ws = new WebSocket(`ws://localhost:${PORT}`);

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

let waitingForResponse = false;
let needsLabel = false;
let hasVisibleText = false;

// ─── Thinking animation ──────────────────────────────────────────────────────
let thinkingTimer = null;
let dotCount = 0;
const THINKING_PREFIX = "🧠 Thinking";

function startThinking() {
  dotCount = 0;
  process.stdout.write(`\r${THINKING_PREFIX}`);
  thinkingTimer = setInterval(() => {
    dotCount = (dotCount % 3) + 1;
    const dots = ".".repeat(dotCount);
    const pad = " ".repeat(3 - dotCount);
    process.stdout.write(`\r${THINKING_PREFIX}${dots}${pad}`);
  }, 500);
}

function stopThinking() {
  if (thinkingTimer) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
    // Clear the thinking line
    process.stdout.write(`\r${" ".repeat(THINKING_PREFIX.length + 4)}\r`);
  }
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
async function chat() {
  console.log("\n🧠 Aperio Chat");
  console.log("─────────────────────────────────────");
  console.log("Your AI assistant with persistent memory");
  console.log('Type "exit" to quit\n');

  await new Promise((resolve, reject) => {
    ws.on("open", () => {
      console.log("✅ Connected to Aperio server\n");
      startThinking();
      resolve();
    });
    ws.on("error", (err) => {
      console.error("❌ Connection failed:", err.message);
      reject(err);
    });
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "stream_start") {
        waitingForResponse = true;
        needsLabel = true;
        hasVisibleText = false;
      } else if (msg.type === "token") {
        if (needsLabel) {
          stopThinking();
          process.stdout.write("\x1b[36mClaude:\x1b[0m " + msg.text);
          needsLabel = false;
          hasVisibleText = true;
        } else {
          process.stdout.write(msg.text);
          hasVisibleText = true;
        }
      } else if (msg.type === "stream_end") {
        needsLabel = false;
        if (hasVisibleText) {
          stopThinking();
          console.log("\n");
          waitingForResponse = false;
          promptUser();
        }
      }
    } catch (err) {
      console.error("Parse error:", err.message);
    }
  });

  ws.on("close", () => {
    stopThinking();
    console.log("\n🔌 Disconnected");
    process.exit(0);
  });

  function promptUser() {
    rl.question("\x1b[33mYou:\x1b[0m ", (input) => {
      const trimmed = input.trim();

      if (trimmed.toLowerCase() === "exit") {
        console.log("Goodbye! 🧠");
        ws.close();
        rl.close();
        process.exit(0);
      }

      if (!trimmed) {
        promptUser();
        return;
      }

      waitingForResponse = true;
      startThinking();
      ws.send(JSON.stringify({ type: "chat", text: trimmed }));
    });
  }

  ws.send(JSON.stringify({ type: "init" }));
}

chat().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
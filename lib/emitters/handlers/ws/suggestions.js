// lib/emitters/handlers/ws/suggestions.js
// save_suggestions handler: persists memory-suggestion chips the user accepted.

import logger from "../../../helpers/logger.js";
import { sendMemories } from "./memories.js";

// Parses structured agent output: "[fact] **User prefers X** — summary"
export function parseSuggestionItem(raw) {
  const text = raw.trim();
  const VALID_TYPES = new Set(["fact","preference","decision","project","solution","source","person"]);

  const typeMatch = text.match(/^\[(\w+)\]\s*/);
  const type = typeMatch && VALID_TYPES.has(typeMatch[1].toLowerCase())
    ? typeMatch[1].toLowerCase()
    : null;
  const rest = (typeMatch ? text.slice(typeMatch[0].length) : text)
    .replace(/\*\*/g, "").trim();

  const dash = rest.indexOf(" — ");
  if (dash > -1) {
    const title = rest.slice(0, dash).trim();
    const content = rest.slice(dash + 3).trim();
    return { type: type ?? guessSuggestionType(rest), title, content };
  }

  return {
    type: type ?? guessSuggestionType(rest),
    title: rest.length > 70 ? `${rest.slice(0, 67)}…` : rest,
    content: rest,
  };
}

export function guessSuggestionType(text) {
  const t = text.toLowerCase();
  if (/\bprefer|dislike\b/.test(t)) return "preference";
  if (/\bdecid|chose|agreed|resolved\b/.test(t)) return "decision";
  if (/\bproject|using|stack|tech\b/.test(t)) return "project";
  return "fact";
}

export async function handleSaveSuggestions(items, { callTool, send, sessionLogger, store }) {
  const list = Array.isArray(items) ? items : [];
  let saved = 0;
  for (const { text } of list) {
    if (!text?.trim()) continue;
    try {
      const { type, title, content } = parseSuggestionItem(text);
      await callTool("remember", {
        type,
        title,
        content,
        tags: ["memory-suggestion"],
        importance: 3,
      });
      saved++;
    } catch (err) {
      sessionLogger.error("handleSaveSuggestions item failed", { err: err.message, text: text?.slice(0, 80) });
      logger.warn("[ws] save_suggestion failed:", err.message);
    }
  }
  send("suggestions_saved", { saved, total: list.length });
  await sendMemories({ store, send, sessionLogger });
}

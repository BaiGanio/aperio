// mcp/lib/validateOutput.js
// Zod-based JSON validation with retry/repair for local Ollama models.
//
// Local models (LLaVA, Qwen, Gemma) frequently:
//   - Wrap JSON in ```json … ``` fences
//   - Add preamble text before the JSON object
//   - Omit required fields
//   - Return truncated JSON when output is long
//
// This module gives you a call-with-retry wrapper and a standalone parse helper.

import { ZodError } from "zod";

// Matches ```json ... ``` and bare ``` ... ``` fences, with or without newlines
const FENCE_RE = /^```(?:json|JSON)?\s*\n?|\n?```\s*$/gm;

// Matches any text before the first { or [ — strips preamble like "Here is the JSON:"
const PREAMBLE_RE = /^[^[{]*/s;

/**
 * Strip markdown fences and leading prose, then parse JSON.
 * Throws SyntaxError on invalid JSON — does NOT validate schema.
 *
 * @param {string} raw - Raw string from model
 * @returns {unknown}  - Parsed JS value
 */
export function cleanAndParse(raw) {
  const stripped = raw
    .trim()
    .replace(FENCE_RE, "")   // remove fences
    .replace(PREAMBLE_RE, "") // remove leading prose
    .trim();

  return JSON.parse(stripped);
}

/**
 * Build a repair prompt that shows the model exactly what broke and what's needed.
 * Keeping the broken output in the prompt is the key — the model can self-correct
 * rather than producing a completely different (also wrong) structure.
 *
 * @param {import("zod").ZodTypeAny} schema
 * @param {string} brokenOutput
 * @param {string} reason       - Human-readable error from Zod or JSON.parse
 * @returns {string}
 */
function buildRepairPrompt(schema, brokenOutput, reason) {
  // Use Zod's JSON Schema export for the hint — readable by the model
  let schemaHint;
  try {
    // zod v3.23+ exposes ._def; for a readable hint we serialise the shape
    schemaHint = JSON.stringify(schema._def?.shape?.() ?? schema._def, null, 2);
  } catch {
    schemaHint = "(schema not serialisable — check field names and types)";
  }

  return [
    "Your previous response could not be used. Fix it and return ONLY valid JSON.",
    "",
    `Error: ${reason}`,
    "",
    "Your broken response was:",
    brokenOutput,
    "",
    "Required schema (field names and types):",
    schemaHint,
    "",
    "Rules:",
    "- Return ONLY a JSON object. No explanation, no markdown fences, no extra text.",
    "- Do not add fields that are not in the schema.",
    "- All required fields must be present.",
  ].join("\n");
}

/**
 * Call an async model function, parse its output against a Zod schema,
 * and retry with a repair prompt on failure.
 *
 * @param {string}   initialPrompt  - The original prompt to send
 * @param {Function} modelFn        - async (prompt: string) => string
 * @param {import("zod").ZodTypeAny} schema - Zod schema to validate against
 * @param {object}   options
 * @param {number}   options.maxRetries - How many times to retry (default 3)
 * @param {string}   options.label     - Label for log messages (default "callWithValidation")
 * @returns {Promise<import("zod").infer<typeof schema>>}
 */
export async function callWithValidation(initialPrompt, modelFn, schema, options = {}) {
  const { maxRetries = 3, label = "callWithValidation" } = options;

  let prompt    = initialPrompt;
  let lastError = null;
  let lastRaw   = "";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    lastRaw = await modelFn(prompt);

    try {
      const parsed = cleanAndParse(lastRaw);
      const result = schema.parse(parsed); // throws ZodError if shape is wrong
      if (attempt > 1) {
        console.error(`✅ [${label}] valid on attempt ${attempt}`);
      }
      return result;

    } catch (err) {
      lastError = err;

      const reason = err instanceof ZodError
        ? err.issues.map(e => `${e.path.join(".") || "(root)"}: ${e.message}`).join("; ")
        : err.message;

      console.error(`⚠️  [${label}] attempt ${attempt}/${maxRetries} failed: ${reason}`);

      if (attempt < maxRetries) {
        prompt = buildRepairPrompt(schema, lastRaw, reason);
      }
    }
  }

  throw new Error(
    `[${label}] model failed to produce valid output after ${maxRetries} attempts. ` +
    `Last error: ${lastError?.message}. Last raw output:\n${lastRaw}`
  );
}

/**
 * Standalone: just parse + validate a string you already have.
 * Useful for validating Ollama streaming output after assembly.
 *
 * @param {string} raw
 * @param {import("zod").ZodTypeAny} schema
 * @returns {{ success: true, data: unknown } | { success: false, error: string }}
 */
export function validateRaw(raw, schema) {
  try {
    const parsed = cleanAndParse(raw);
    const data   = schema.parse(parsed);
    return { success: true, data };
  } catch (err) {
    const error = err instanceof ZodError
      ? err.issues.map(e => `${e.path.join(".")}: ${e.message}`).join("; ")
      : err.message;
    return { success: false, error };
  }
}
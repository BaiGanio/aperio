/**
 * skills/reasoning-planning/index.js
 */
export async function run(input) {
  // Logic to process the request
  const cleanInput = input.replace(/use reasoning-planning to/i, '').trim();
  
  return [
    `🤖 REASONING-PLANNING OUTPUT`,
    `─`.repeat(30),
    `Target: ${cleanInput}`,
    `Steps:`,
    `1. Identify core components of learning from feedback.`,
    `2. Design a persistent memory store for corrections.`,
    `3. Implement a reinforcement loop for the LLM prompts.`,
    `─`.repeat(30)
  ].join('\n');
}

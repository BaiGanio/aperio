// lib/helpers/completion.js
// Minimal single-turn completion call for background workers (inference, etc.).
// Not for interactive use — no streaming, no tool use.

import { resolveProvider } from '../providers/index.js';

export async function complete(messages, { maxTokens = 600 } = {}) {
  const provider = resolveProvider();

  if (provider.name === 'anthropic') {
    const resp = await provider.client.messages.create({
      model:      provider.model,
      max_tokens: maxTokens,
      messages,
    });
    return resp.content[0]?.text ?? '';
  }

  // Ollama and DeepSeek both expose an OpenAI-compatible endpoint
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

  const res = await fetch(`${provider.baseURL}/chat/completions`, {
    method:  'POST',
    headers,
    body:    JSON.stringify({ model: provider.model, messages, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`Completion failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.choices[0]?.message?.content ?? '';
}

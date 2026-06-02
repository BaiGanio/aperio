// lib/helpers/completion.js
// Minimal single-turn completion call for background workers (inference, etc.).
// Not for interactive use — no streaming, no tool use.

import { resolveProvider } from '../providers/index.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

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

  if (provider.name === 'gemini') {
    const geminiModel = provider.client.getGenerativeModel({ model: provider.model });
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : (m.content?.[0]?.text ?? '') }],
    }));
    const result = await geminiModel.generateContent({ contents, generationConfig: { maxOutputTokens: maxTokens } });
    return result.response.text();
  }

  if (provider.name === 'claude-code') {
    const subEnv = { ...process.env };
    delete subEnv.ANTHROPIC_API_KEY;
    const lastMsg = messages[messages.length - 1];
    const prompt = typeof lastMsg?.content === 'string' ? lastMsg.content : lastMsg?.content?.[0]?.text ?? '';
    let result = '';
    for await (const msg of query({
      prompt,
      options: { model: provider.model, maxTurns: 1, allowedTools: [], settingSources: [], env: subEnv },
    })) {
      if (msg.type === 'result') result = msg.result ?? '';
    }
    return result;
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

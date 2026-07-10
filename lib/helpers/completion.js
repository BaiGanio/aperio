// lib/helpers/completion.js
// Minimal single-turn completion call for background workers (inference, etc.).
// Not for interactive use — no streaming, no tool use.

import { resolveProvider, isLocalProvider } from '../providers/index.js';
import { redactMessages } from './redactSecrets.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function completeWithCodex(messages, provider, {
  exec = execFileAsync,
  cwd = process.cwd(),
} = {}) {
  const prompt = messages
    .map(m => {
      const content = typeof m.content === 'string'
        ? m.content
        : m.content?.filter?.(b => b.type === 'text').map(b => b.text).join('\n') ?? '';
      return `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${content}`;
    })
    .join('\n\n');
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--sandbox', 'read-only',
    '--model', provider.model,
    '-c', 'approval_policy="never"',
    `Return only the requested answer. Do not inspect files or run tools.\n\n${prompt}`,
  ];
  try {
    const { stdout } = await exec('codex', args, {
      cwd,
      env: process.env,
      timeout: Math.max(1_000, Number(process.env.CODEX_COMPLETION_TIMEOUT_MS) || 120_000),
      maxBuffer: 10 * 1024 * 1024,
    });
    let result = '';
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          result = event.item.text ?? result;
        }
        if (event.type === 'turn.failed' || event.type === 'error') {
          throw new Error(event.error?.message || event.message || 'Codex completion failed');
        }
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
    if (!result) throw new Error('Codex exited without a final response');
    return result;
  } catch (err) {
    const detail = err.stderr?.trim() || err.message;
    throw new Error(`Codex completion failed: ${detail}`, { cause: err });
  }
}

export async function complete(messages, { maxTokens = 600 } = {}) {
  const provider = resolveProvider();
  // PRIVACY-01: scrub secrets before background completions reach a cloud model.
  if (!isLocalProvider(provider.name)) messages = redactMessages(messages);

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

  if (provider.name === 'codex') {
    return completeWithCodex(messages, provider);
  }

  // llama.cpp and DeepSeek both expose an OpenAI-compatible endpoint
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

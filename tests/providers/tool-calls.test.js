// T2.5 - tool-call parsing (spec S2.5, adapter behaviour 4-5).
//
// Ported from v1 (archive/v1-final) tests/unit/tools/executor.test.js:
// extractAngleToolCall (Ornith), extractPipeAngleToolCall (gemma),
// detectToolCallLeak, recoverToolName, looksLikeSystemPromptEcho. Each leak
// shape is a named case (L-M05). Changed on purpose:
// - Bad JSON is NEVER repaired and NEVER turned into `{}` (Test Reuse Map edge
//   case, decision 4). v1 parseArgs regex-repaired it; v1 extractTextToolCall
//   turned it into {} (executor.js ln 316). Both are now `bad_tool_json`.
// - extractTextToolCall takes the known tool names only (no `messages`), and an
//   empty list matches nothing (v1 fell back to "any name").
// Not ported: v1 bbcode / OpenAI-wire / kwarg extractors (no measured need in
// v2; they come back through the return gate if the eval shows the shape).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseToolArgs, extractAngleToolCall, extractPipeAngleToolCall, extractTextToolCall,
  detectToolCallLeak, recoverToolName, looksLikeSystemPromptEcho,
} from '../../src/providers/tool-calls.js';

const TOOLS = ['remember', 'recall', 'update', 'forget', 'list'];

describe('parseToolArgs: bad JSON is reported, never {}', () => {
  test('empty or missing arguments mean "no arguments"', () => {
    for (const raw of ['', '   ', undefined, null]) {
      assert.deepEqual(parseToolArgs(raw), { ok: true, args: {} }, `raw=${JSON.stringify(raw)}`);
    }
  });

  test('a valid JSON object is returned as is', () => {
    assert.deepEqual(parseToolArgs('{"query":"Pixel","limit":3}'), { ok: true, args: { query: 'Pixel', limit: 3 } });
  });

  test('truncated JSON is bad_tool_json with the raw text kept byte for byte', () => {
    const raw = '{"query": "Pix';
    const r = parseToolArgs(raw);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'bad_tool_json');
    assert.equal(r.raw, raw);
    assert.match(r.message, /JSON/);
    assert.equal('args' in r, false, 'a failed parse carries no args at all, so nothing can run with {}');
  });

  test('v1 "repairable" shapes are not repaired any more (decision 4)', () => {
    for (const raw of ['{"key""val"}', '{"key: "val"}', '{"content": "a "quoted" word"}', "{'single': 1}", '{query: "x"}']) {
      const r = parseToolArgs(raw);
      assert.equal(r.ok, false, raw);
      assert.equal(r.error, 'bad_tool_json', raw);
      assert.equal(r.raw, raw);
    }
  });

  test('valid JSON that is not an object is bad_tool_json too', () => {
    for (const raw of ['[1,2]', '"text"', '42', 'null', 'true']) {
      const r = parseToolArgs(raw);
      assert.equal(r.ok, false, raw);
      assert.equal(r.error, 'bad_tool_json', raw);
      assert.match(r.message, /object/);
    }
  });
});

describe('extractAngleToolCall (Ornith shape, L-M05)', () => {
  test('returns null for empty or non-angle text (ported)', () => {
    assert.equal(extractAngleToolCall(''), null);
    assert.equal(extractAngleToolCall("I'll check that for you."), null);
  });

  test('parses the tool name and a <parameter=key> value (ported)', () => {
    assert.deepEqual(
      extractAngleToolCall('<tool_call> <function=recall> <parameter=query> Pixel </parameter> </function> </tool_call>'),
      { name: 'recall', input: { query: 'Pixel' }, trailing: '' },
    );
  });

  test('handles a no-parameter call (ported)', () => {
    assert.deepEqual(extractAngleToolCall('<tool_call> <function=list> </function> </tool_call>'), { name: 'list', input: {}, trailing: '' });
  });

  test('recovers the call when prose comes first (ported)', () => {
    const r = extractAngleToolCall('Let me look. <tool_call> <function=recall> <parameter=query> dog </parameter> </function> </tool_call>');
    assert.equal(r.name, 'recall');
    assert.deepEqual(r.input, { query: 'dog' });
  });

  test('JSON-parses an array/object parameter value, keeps scalars as strings (ported)', () => {
    const r = extractAngleToolCall('<tool_call> <function=remember> <parameter=content> blue </parameter> <parameter=tags> ["prefs","color"] </parameter> </function> </tool_call>');
    assert.deepEqual(r.input, { content: 'blue', tags: ['prefs', 'color'] });
  });
});

describe('extractPipeAngleToolCall (gemma shape, L-M05)', () => {
  test('returns null for empty or non-matching text (ported)', () => {
    assert.equal(extractPipeAngleToolCall(''), null);
    assert.equal(extractPipeAngleToolCall("I'll search for that."), null);
  });

  test('recovers the exact recorded leak: pipe-quoted string argument (ported)', () => {
    assert.deepEqual(
      extractPipeAngleToolCall('<|tool_call>call:recall{query:<|"|>Northwind Labs<|"|>}<tool_call|>'),
      { name: 'recall', input: { query: 'Northwind Labs' }, trailing: '' },
    );
  });

  test('handles a no-parameter call (ported)', () => {
    assert.deepEqual(extractPipeAngleToolCall('<|tool_call>call:list{}<tool_call|>'), { name: 'list', input: {}, trailing: '' });
  });

  test('mixes pipe-quoted strings and bare numbers (ported)', () => {
    const r = extractPipeAngleToolCall('<|tool_call>call:recall{query:<|"|>Northwind<|"|>,limit:5}<tool_call|>');
    assert.deepEqual(r.input, { query: 'Northwind', limit: 5 });
  });

  test('recovers the call when prose comes first (ported)', () => {
    const r = extractPipeAngleToolCall('Let me look. <|tool_call>call:recall{query:<|"|>dog<|"|>}<tool_call|>');
    assert.equal(r.name, 'recall');
  });

  test('a matched shape with an unparseable body is bad_tool_json, never {} (v2 change)', () => {
    const r = extractPipeAngleToolCall('<|tool_call>call:remember{content:<|"|>unclosed}<tool_call|>');
    assert.equal(r.name, 'remember');
    assert.equal(r.error, 'bad_tool_json');
    assert.equal(typeof r.raw, 'string');
    assert.notDeepEqual(r.input, {});
  });
});

describe('extractTextToolCall: the known-tool gate', () => {
  test('recovers both leak shapes for a known tool (ported)', () => {
    assert.equal(extractTextToolCall('<tool_call> <function=recall> <parameter=query> x </parameter> </function> </tool_call>', TOOLS).name, 'recall');
    assert.equal(extractTextToolCall('<|tool_call>call:recall{query:<|"|>x<|"|>}<tool_call|>', TOOLS).name, 'recall');
  });

  test('an unknown tool name is not a call (ported gate)', () => {
    assert.equal(extractTextToolCall('<tool_call> <function=made_up> </function> </tool_call>', TOOLS), null);
    assert.equal(extractTextToolCall('<|tool_call>call:made_up{q:<|"|>x<|"|>}<tool_call|>', TOOLS), null);
  });

  test('an empty tool list matches nothing (v2: no permissive fallback)', () => {
    assert.equal(extractTextToolCall('<|tool_call>call:recall{query:<|"|>x<|"|>}<tool_call|>', []), null);
  });

  test('ordinary prose ending in a parenthetical is not a call (v1 "US Letter" bug)', () => {
    assert.equal(extractTextToolCall('Use US Letter (612 × 792 points).', TOOLS), null);
  });

  test('bad JSON inside a known-tool leak stays bad_tool_json through the gate', () => {
    const r = extractTextToolCall('<|tool_call>call:remember{content:<|"|>unclosed}<tool_call|>', TOOLS);
    assert.equal(r.error, 'bad_tool_json');
  });
});

describe('detectToolCallLeak (ported)', () => {
  test('flags tool-call tags and call(...) notation', () => {
    assert.equal(detectToolCallLeak('<tool_call>recall</tool_call>', TOOLS), true);
    assert.equal(detectToolCallLeak('<invoke name="recall">', TOOLS), true);
    assert.equal(detectToolCallLeak('call(recall, query="exam")', TOOLS), true);
    assert.equal(detectToolCallLeak('<execute_tool>\ncall(recall, query="x")\n</execute_tool>', TOOLS), true);
  });

  test('flags <|tool_call> with the closing pipe dropped, even with no tool list', () => {
    assert.equal(detectToolCallLeak('<|tool_call>call:recall', TOOLS), true);
    assert.equal(detectToolCallLeak('<|tool_call>call:recall', []), true);
  });

  test('flags a known-tool call with a named arg', () => {
    assert.equal(detectToolCallLeak('recall(query="exam")', TOOLS), true);
  });

  test('flags a narrated call the model never issued (gemma)', () => {
    assert.equal(detectToolCallLeak('I need your notes first.\n\nCalling `recall` for "exam".', TOOLS), true);
  });

  test('flags first-person intent to call a known tool', () => {
    assert.equal(detectToolCallLeak("I'll call recall to get the details.", TOOLS), true);
    assert.equal(detectToolCallLeak('Let me use recall to check your memories.', TOOLS), true);
  });

  test('does not flag plain prose, advice, past tense, unknown tools or empty text', () => {
    assert.equal(detectToolCallLeak("I'll recall (from memory) what we discussed.", TOOLS), false);
    assert.equal(detectToolCallLeak('Let me check your memories for the exam.', TOOLS), false);
    assert.equal(detectToolCallLeak('You can call recall with a query.', TOOLS), false);
    assert.equal(detectToolCallLeak('I called recall and here is what I found.', TOOLS), false);
    assert.equal(detectToolCallLeak('Calling fetch_url for the page.', TOOLS), false);
    assert.equal(detectToolCallLeak('list is a word I use a lot.', TOOLS), false);
    assert.equal(detectToolCallLeak('', TOOLS), false);
    assert.equal(detectToolCallLeak('  \n ', TOOLS), false);
  });
});

describe('recoverToolName (ported)', () => {
  test('a known name comes back unchanged', () => {
    assert.equal(recoverToolName('recall', TOOLS), 'recall');
  });

  test('recovers the real name from gemma channel markup', () => {
    assert.equal(recoverToolName('thought <|channel>thought <channel|><|tool_call>call:recall', TOOLS), 'recall');
  });

  test('prefers the last embedded name (the one after the call marker)', () => {
    assert.equal(recoverToolName('<|channel>I will use list<|tool_call>call:recall', TOOLS), 'recall');
  });

  test('matches on token boundaries, not substrings', () => {
    assert.equal(recoverToolName('call:db_query', ['query', 'db_query']), 'db_query');
  });

  test('null when no known tool is embedded', () => {
    assert.equal(recoverToolName('<|tool_call>call:made_up', TOOLS), null);
    assert.equal(recoverToolName('', TOOLS), null);
    assert.equal(recoverToolName('recall', []), null);
  });
});

describe('looksLikeSystemPromptEcho (ported)', () => {
  const system = [
    'Aperio is a small local assistant that remembers. It keeps the user memories',
    'in a local database and answers with them in mind. Be brief and be honest.',
    'Say plainly when you do not know something, and never invent a memory.',
    'Use the tools only when the answer needs them; answer directly otherwise.',
  ].join('\n');

  test('flags a large verbatim recitation', () => {
    assert.equal(looksLikeSystemPromptEcho(system.repeat(2), system), true);
  });

  test('does not flag an unrelated answer or a short quote', () => {
    assert.equal(looksLikeSystemPromptEcho('Your dog Pixel is three years old, you told me last week.', system), false);
    assert.equal(looksLikeSystemPromptEcho('I will be brief and be honest: I do not know.', system), false);
  });

  test('false for empty text or an empty system prompt', () => {
    assert.equal(looksLikeSystemPromptEcho('', system), false);
    assert.equal(looksLikeSystemPromptEcho(system, ''), false);
  });
});

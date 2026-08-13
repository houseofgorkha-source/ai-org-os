import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCallText } from '../src/provider-anthropic.ts';
import type { AnthropicContentBlock } from '../src/provider-anthropic.ts';

/**
 * `toCallText` is the fix for the actual observed failure across four real
 * runs (aios-harness-XXh05t, QZbz7X, and two more): the model's second turn
 * produced ZERO parsed actions — not even a malformed one — meaning it never
 * attempted the free-text `CALL` convention at all. This translates
 * Anthropic's native, schema-validated `tool_use` blocks into that same
 * convention IN CODE, never from the model's own text, so the executor's
 * parser (executor.ts, unchanged) always receives well-formed input when the
 * model calls a tool. No live API call is made anywhere in this file.
 */

test('T-N1 a tool_use block becomes a single well-formed CALL line', () => {
  const blocks: AnthropicContentBlock[] = [
    { type: 'tool_use', name: 'fs_read', input: { scope: 'workspace://src/app.js', args: { path: 'src/app.js' } } },
  ];
  const text = toCallText(blocks);
  assert.equal(text, 'CALL fs.read workspace://src/app.js {"path":"src/app.js"}');
  assert.equal(text.split('\n').length, 1, 'exactly one physical line');
});

test('T-N2 multiple tool_use blocks become multiple well-formed CALL lines, one per block', () => {
  const blocks: AnthropicContentBlock[] = [
    { type: 'text', text: 'I will read then write.' },
    { type: 'tool_use', name: 'fs_read', input: { scope: 'workspace://src/app.js', args: { path: 'src/app.js' } } },
    { type: 'tool_use', name: 'fs_write', input: { scope: 'workspace://src/app.js', args: { path: 'src/app.js', content: 'x' } } },
  ];
  const lines = toCallText(blocks).split('\n');
  assert.equal(lines.length, 2, 'accompanying prose is dropped; only structured calls become text');
  assert.ok(lines[0]!.startsWith('CALL fs.read '));
  assert.ok(lines[1]!.startsWith('CALL fs.write '));
});

test('T-N3 a file content argument containing real newlines never breaks single-line CALL syntax', () => {
  // This is the exact failure class the free-text path was vulnerable to:
  // a multi-line file body pretty-printed into JSON would previously have to
  // survive the MODEL formatting it as valid single-line JSON unaided. Here
  // the content is a raw multi-line string in the STRUCTURED `args` object;
  // JSON.stringify (code, not the model) is what guarantees the escaping.
  const multilineContent = 'function oldFn(a) { return a + 1; }\nfunction newFn(a) { return a + 1; }\n';
  const blocks: AnthropicContentBlock[] = [
    { type: 'tool_use', name: 'fs_write', input: { scope: 'workspace://src/app.js', args: { path: 'src/app.js', content: multilineContent } } },
  ];
  const text = toCallText(blocks);
  assert.equal(text.split('\n').length, 1, 'the CALL line itself contains no raw newline');
  const m = /^CALL fs\.write workspace:\/\/src\/app\.js (\{.*\})$/.exec(text);
  assert.ok(m, 'matches the exact grammar executor.ts\'s parser requires');
  const parsedArgs = JSON.parse(m![1]!) as { path: string; content: string };
  assert.equal(parsedArgs.content, multilineContent, 'the real newlines survive intact, safely escaped');
});

test('T-N4 a done tool_use maps to exactly the DONE convention', () => {
  const blocks: AnthropicContentBlock[] = [{ type: 'tool_use', name: 'done', input: {} }];
  assert.equal(toCallText(blocks), 'DONE');
});

test('T-N5 a refuse tool_use maps to the REFUSE convention, carrying the reason', () => {
  const blocks: AnthropicContentBlock[] = [{ type: 'tool_use', name: 'refuse', input: { reason: 'no target symbol named X' } }];
  assert.equal(toCallText(blocks), 'REFUSE no target symbol named X');
});

test('T-N6 no tool_use at all falls back to the plain text, unmodified', () => {
  const blocks: AnthropicContentBlock[] = [{ type: 'text', text: 'still thinking about this' }];
  assert.equal(toCallText(blocks), 'still thinking about this');
});

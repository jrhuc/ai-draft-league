import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  emptyMemory,
  MEMORY_LIMITS,
  parseMemoryReply,
  readMemoryPage,
  renderMemory,
  validateMemory,
} from '../src/franchise-memory.js';

test('memory limits reject with the reason instead of clipping', () => {
  assert.equal(validateMemory(emptyMemory('x'.repeat(MEMORY_LIMITS.pageChars))), undefined);
  assert.match(String(validateMemory(emptyMemory('x'.repeat(MEMORY_LIMITS.pageChars + 1)))), /limit is 8000/);
  assert.match(String(validateMemory({ notebook: '', 'Bad Name': 'x' })), /page name "Bad Name"/);
  const many: Record<string, string> = { notebook: '' };
  for (let index = 0; index < MEMORY_LIMITS.pages; index += 1) many[`p${index}`] = 'x';
  assert.match(String(validateMemory(many)), /17 pages; the limit is 16/);
  const heavy: Record<string, string> = { notebook: '' };
  for (let index = 0; index < 7; index += 1) heavy[`p${index}`] = 'x'.repeat(MEMORY_LIMITS.pageChars);
  assert.match(String(validateMemory(heavy)), /totals 56000 characters/);
});

test('a reply changes only what it names: set_pages merges, delete_pages removes, omissions keep', () => {
  const current = { notebook: 'old', lessons: 'keep', scouting: 'drop' };
  const kept = parseMemoryReply({ notebook: ' new ' }, current);
  assert.ok(typeof kept !== 'string');
  assert.deepEqual(kept.memory, { notebook: 'new', lessons: 'keep', scouting: 'drop' });
  const merged = parseMemoryReply({ set_pages: { lessons: 'revised', plans: 'new page' } }, current);
  assert.ok(typeof merged !== 'string');
  assert.deepEqual(merged.memory, { notebook: 'old', lessons: 'revised', plans: 'new page', scouting: 'drop' });
  const pruned = parseMemoryReply({ notebook: 'old', delete_pages: ['scouting', 'missing'] }, current);
  assert.ok(typeof pruned !== 'string');
  assert.deepEqual(pruned.memory, { notebook: 'old', lessons: 'keep' });
  const unchanged = parseMemoryReply({}, current);
  assert.ok(typeof unchanged !== 'string');
  assert.deepEqual(unchanged.memory, current);
  assert.match(String(parseMemoryReply({ set_pages: { notebook: 'x' } }, current)), /may not contain/);
  assert.match(String(parseMemoryReply({ set_pages: ['x'] }, current)), /must be an object/);
  assert.match(String(parseMemoryReply({ notebook: 3 }, current)), /"notebook" must be a string/);
  assert.match(String(parseMemoryReply({ delete_pages: 'scouting' }, current)), /must be an array/);
  assert.match(String(parseMemoryReply({ delete_pages: ['notebook'] }, current)), /cannot be deleted/);
  assert.match(
    String(parseMemoryReply({ set_pages: { lessons: 'x' }, delete_pages: ['lessons'] }, current)),
    /both set and deleted/,
  );
  assert.match(String(parseMemoryReply({ notebook: 'n', pages: {} }, current)), /"pages" is not a field/);
});

test('the prompt shows the notebook in full and indexes the other pages', () => {
  const memory = { notebook: 'Lead Garchomp.', 'opp.beta': 'Beta brings Trick Room.\nSecond line.', lessons: '' };
  const index = renderMemory(memory).join('\n');
  assert.match(index, /^YOUR NOTEBOOK:\nLead Garchomp\./);
  assert.match(
    index,
    /YOUR MEMORY PAGES \(name \| characters \| first line\):\n- lessons \| 0 \| \n- opp\.beta \| 36 \| Beta brings Trick Room\./,
  );
  assert.doesNotMatch(index, /Second line/);
  assert.match(
    renderMemory(memory, 'full').join('\n'),
    /YOUR MEMORY PAGE opp\.beta:\nBeta brings Trick Room\.\nSecond line\./,
  );
  assert.deepEqual(renderMemory(emptyMemory()), ['YOUR NOTEBOOK:', '(empty)']);
  assert.equal(readMemoryPage(memory, { name: 'opp.beta' }), 'Beta brings Trick Room.\nSecond line.');
  assert.equal(readMemoryPage(memory, { name: 'lessons' }), '(empty)');
  assert.match(
    readMemoryPage(memory, { name: 'missing' }),
    /no page named "missing". Your pages: notebook, lessons, opp.beta/,
  );
});

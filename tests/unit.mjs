import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const base = new URL('../', import.meta.url).href;
const { __test: T } = await import(base + 'src/content/isolated/modules/anti-vanish.js');
const lic = await import(base + 'src/shared/license.js');

// --- delta-encoded stream (current ChatGPT format) ---
let st = T.newStreamState('r1', { prompt: 'q', model: 'gpt-5' });
const frames = [
  '"v1"',
  JSON.stringify({ p: '', o: 'add', v: { message: { id: 'msg-1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] }, status: 'in_progress', metadata: { model_slug: 'gpt-5-thinking' } }, conversation_id: 'abc-123', error: null }, c: 0 }),
  JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: 'Copenhagen' }),
  JSON.stringify({ v: ' is the capital' }),
  JSON.stringify({ v: ' of Denmark.' }),
  JSON.stringify({ p: '', o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }, { p: '/message/end_turn', o: 'replace', v: true }] }),
  JSON.stringify({ v: ' Bonus.' }),   // shorthand after a patch must still target parts/0
  JSON.stringify({ type: 'message_stream_complete', conversation_id: 'abc-123' }),
  '[DONE]',
];
for (const f of frames) T.ingestLine(st, f);
assert.equal(T.assistantText(st.message), 'Copenhagen is the capital of Denmark. Bonus.');
assert.equal(st.message.id, 'msg-1');
assert.equal(st.message.status, 'finished_successfully');
assert.equal(st.conversationId, 'abc-123');
assert.equal(st.model, 'gpt-5-thinking');
assert.equal(st.done, true);
console.log('✓ delta-encoded assembly');

// --- legacy full-message frames ---
st = T.newStreamState('r2', {});
for (const parts of [['Hel'], ['Hello'], ['Hello world']]) {
  T.ingestLine(st, JSON.stringify({ message: { id: 'm2', author: { role: 'assistant' }, content: { content_type: 'text', parts } }, conversation_id: 'c2' }));
}
assert.equal(T.assistantText(st.message), 'Hello world');
console.log('✓ full-message assembly');

// --- tool frames do not clobber the assistant message ---
st = T.newStreamState('r3', {});
T.ingestLine(st, JSON.stringify({ message: { id: 'a', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Answer'] } } }));
T.ingestLine(st, JSON.stringify({ message: { id: 't', author: { role: 'tool' }, content: { content_type: 'text', parts: ['tool output'] } } }));
assert.equal(T.assistantText(st.message), 'Answer');
console.log('✓ tool frames ignored');

// --- garbage is tolerated ---
st = T.newStreamState('r4', {});
for (const g of ['', 'not json', '{"weird":1}', '\u0000event:ping']) T.ingestLine(st, g);
assert.equal(T.assistantText(st.message), '');
console.log('✓ garbage tolerated');

// --- license ---
const key = lic.generateKey('unit-test');
assert.match(key, /^CGF-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
assert.equal((await lic.verifyKey(key)).ok, true);
assert.equal((await lic.verifyKey(key.toLowerCase().replace(/-/g, ' - '))).ok, true, 'normalization');
const tampered = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
assert.equal((await lic.verifyKey(tampered)).ok, false);
assert.equal((await lic.verifyKey('CGF-1234')).ok, false);
console.log('✓ license checksum', key);
console.log('UNIT OK');

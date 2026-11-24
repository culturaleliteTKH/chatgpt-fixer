import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const EXT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const PROFILE = process.env.PROFILE || tmpdir() + '/cgf-e2e-profile';
rmSync(PROFILE, { recursive: true, force: true });

const PAGE = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>Denmark facts - ChatGPT</title></head><body>
<nav aria-label="Chat history">
  <a data-testid="create-new-chat-button" href="/">New chat</a>
  <a href="/c/abc-123" id="older">Older chat</a>
  <button data-testid="close-sidebar-button" aria-label="Close sidebar" onclick="document.body.dataset.sidebar='toggled'">x</button>
</nav>
<main>
  <article data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="u1">Hello there, tell me about Denmark. ${'Lorem ipsum dolor sit amet. '.repeat(60)}</div></article>
  <article data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="a1">Denmark is a Nordic country in Northern Europe. <blockquote>tell me about Denmark</blockquote></div></article>
  <div data-turn-key="t3" data-conversation-role="user" data-virtualized-turn=""><div data-user-message-bubble="">New-style user bubble</div></div>
  <div data-turn-key="t4" data-conversation-role="assistant" data-virtualized-turn=""><div data-dil-message-id="m4"><div data-response-body="">New-style assistant body</div></div></div>
  <form><div id="prompt-textarea" contenteditable="true"></div><button type="button" data-testid="send-button">Send</button></form>
</main>
<script>
  window.sendIt = () => fetch('/backend-api/conversation', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'next', model: 'gpt-5', conversation_id: 'abc-123', parent_message_id: 'u1',
      messages: [{ content: { content_type: 'text', parts: ['What is the capital?'] } }] }) }).then(r => r.text());
</script></body></html>`;

const SSE = [
  'event: delta_encoding', 'data: "v1"', '',
  'event: delta', 'data: ' + JSON.stringify({ p: '', o: 'add', v: { message: { id: 'msg-1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] }, status: 'in_progress', metadata: { model_slug: 'gpt-5' } }, conversation_id: 'abc-123', error: null }, c: 0 }), '',
  'event: delta', 'data: ' + JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: 'Copenhagen' }), '',
  'event: delta', 'data: ' + JSON.stringify({ v: ' is the capital of Denmark.' }), '',
  'event: delta', 'data: ' + JSON.stringify({ p: '', o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }] }), '',
  'data: ' + JSON.stringify({ type: 'message_stream_complete', conversation_id: 'abc-123' }), '',
  'data: [DONE]', '', '',
].join('\n');

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await context.route('https://chatgpt.com/**', async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  if (req.method() === 'POST' && /\/backend-api\/conversation$/.test(u.pathname)) {
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: SSE });
  }
  return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: PAGE });
});

let sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
console.log('extension id', extId);

const page = await context.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[page] ${m.type()} ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('https://chatgpt.com/c/abc-123');

// 1. consent modal appears, accept it
await page.waitForSelector('.cgf-consent-card', { timeout: 10000 });
await page.click('.cgf-consent-card .cgf-btn-primary');
await page.waitForFunction(() => document.documentElement.getAttribute('data-cgf-stream') === 'on', null, { timeout: 5000 });
console.log('✓ consent accepted, stream flag on');

// 2. meter rendered
await page.waitForSelector('.cgf-meter', { timeout: 5000 });
const meterText = await page.textContent('.cgf-meter');
assert.match(meterText, /tokens/);
console.log('✓ meter:', meterText.trim());

// 3. fetch interception + assembly + vanish detection (mock page never renders msg-1)
const body = await page.evaluate(() => window.sendIt());
assert.ok(body.includes('Copenhagen'), 'page still receives the original stream');
await page.waitForSelector('.cgf-toast-warn', { timeout: 12000 });
const toastText = await page.textContent('.cgf-toast-warn .cgf-toast-msg');
console.log('✓ vanish toast:', toastText);
await page.click('.cgf-toast-warn .cgf-btn-primary');
await page.waitForSelector('.cgf-panel .cgf-pre-main', { timeout: 5000 });
const recovered = await page.textContent('.cgf-panel .cgf-pre-main');
assert.equal(recovered, 'Copenhagen is the capital of Denmark.');
console.log('✓ recovery panel shows assembled text');

// 3b. insert into composer
await page.click('.cgf-panel button:has-text("Insert into composer")');
const composer = await page.textContent('#prompt-textarea');
assert.ok(composer.includes('Copenhagen'), 'composer insert');
console.log('✓ insert into composer');
await page.keyboard.press('Escape');

// 4. vault contents via service worker IndexedDB
const entries = await sw.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open('cgf-vault');
  r.onsuccess = () => { const tx = r.result.transaction('responses'); const g = tx.objectStore('responses').getAll(); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); };
  r.onerror = () => rej(r.error);
}));
assert.equal(entries.length, 1);
assert.equal(entries[0].status, 'vanished');
assert.equal(entries[0].prompt, 'What is the capital?');
assert.equal(entries[0].conversationId, 'abc-123');
console.log('✓ vault entry:', entries[0].status, entries[0].eventCount, 'events');

// 5. middle-click opens a new tab
const [newPage] = await Promise.all([context.waitForEvent('page'), page.click('#older', { button: 'middle' })]);
await newPage.waitForLoadState();
assert.equal(newPage.url(), 'https://chatgpt.com/c/abc-123');
assert.equal(page.url(), 'https://chatgpt.com/c/abc-123');
await newPage.close();
console.log('✓ middle-click opened new tab');

// 6. Alt+S toggles sidebar
await page.keyboard.press('Alt+s');
await page.waitForFunction(() => document.body.dataset.sidebar === 'toggled', null, { timeout: 3000 });
console.log('✓ Alt+S toggled sidebar');

// 7. quote jump decorates blockquote
await page.waitForSelector('blockquote.cgf-quote', { timeout: 3000 });
console.log('✓ quote decorated');

// 8. project hover action injected on sidebar chat
await page.waitForSelector('#older .cgf-move', { timeout: 3000 });
console.log('✓ move-to-project hover action injected');

// 9. popup: modules, vault, pro activation
const popup = await context.newPage();
popup.on('pageerror', (e) => logs.push(`[popup pageerror] ${e.message}`));
await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
await popup.waitForSelector('.module');
assert.equal(await popup.locator('.module').count(), 5);
await popup.click('.tab[data-tab="vault"]');
await popup.waitForSelector('.entry');
assert.equal(await popup.locator('.entry').count(), 1);
console.log('✓ popup lists 5 modules and 1 vault entry');
const { generateKey } = await import(new URL('../src/shared/license.js', import.meta.url));
await popup.click('.tab[data-tab="pro"]');
await popup.fill('#licenseKey', generateKey('e2e'));
await popup.click('#licenseForm button[type=submit]');
await popup.waitForFunction(() => document.querySelector('#proBadge')?.textContent === 'Pro', null, { timeout: 5000 });
console.log('✓ Pro key activated');
await popup.click('#licenseRemove');
await popup.waitForFunction(() => document.querySelector('#proBadge')?.textContent === 'Free', null, { timeout: 5000 });
console.log('✓ license removed');

// 9b. diagnostics reads both message markups (innermost elements only)
const diag = await popup.evaluate(() => new Promise((resolve) => chrome.tabs.query({ url: 'https://chatgpt.com/*' }, (tabs) => chrome.tabs.sendMessage(tabs[0].id, { type: 'cgf/diag' }, resolve))));
assert.deepEqual(diag.result.messagesRead.map((s) => s.split(':')[0]), ['user', 'assistant', 'user', 'assistant']);
assert.equal(diag.result.version, '0.2.0');
console.log('✓ diagnostics: 4 messages read across old and new markup');

// 10. toggling anti-vanish off flips the stream flag live
await popup.click('.tab[data-tab="fixes"]');
await popup.locator('.module').nth(3).locator('.switch').click();
await page.waitForFunction(() => document.documentElement.getAttribute('data-cgf-stream') === 'off', null, { timeout: 5000 });
console.log('✓ live toggle: stream flag off');

const errs = logs.filter((l) => /pageerror|error/i.test(l) && !/favicon/.test(l));
console.log(errs.length ? 'console errors:\n' + errs.join('\n') : '✓ no console errors');
await context.close();
console.log('E2E OK');

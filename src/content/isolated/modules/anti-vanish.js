// Anti-Vanish: listens to stream events from the MAIN-world interceptor, assembles the assistant
// message from ChatGPT's SSE format (full messages + delta-encoded patches), persists to the vault
// via the service worker, and detects three failure modes:
//   1. interrupted  — stream errored/aborted or went silent for STALE_STREAM_MS
//   2. vanished     — stream finished but the message never appeared (or shrank) in the DOM
//   3. page reload mid-stream — entries left 'streaming' from a previous load are marked interrupted
// Free: vault keeps the newest FREE_VAULT_LIMIT entries. Pro: full history, search, raw events, export.

let ctx = null;
let vault = null;
let streams = new Map(); // requestId -> state
let staleTimer = 0;
let listener = null;
let VaultClient, entryToMarkdown;

// ---------- SSE assembly ----------

function newStreamState(requestId, meta) {
  return {
    requestId,
    message: null,          // latest assistant message object (ChatGPT message schema)
    conversationId: meta?.conversationId || null,
    model: meta?.model || null,
    prompt: meta?.prompt || '',
    lastPath: '/message/content/parts/0',
    lastEventAt: Date.now(),
    startedAt: Date.now(),
    eventCount: 0,
    raw: [],
    status: 'streaming',
    flushTimer: 0,
    dirty: false,
    done: false,
  };
}

function unescapePtr(k) { return k.replace(/~1/g, '/').replace(/~0/g, '~'); }
function ptrSet(obj, path, fn) {
  const keys = path.split('/').slice(1).map(unescapePtr);
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  }
  const last = keys[keys.length - 1];
  o[last] = fn(o[last]);
}

/** Apply one delta op {p, o, v} onto the root ({message, conversation_id,...}). */
function applyOp(st, root, op) {
  const p = op.p != null ? op.p : st.lastPath;
  const o = op.o || (typeof op.v === 'string' ? 'append' : 'replace');
  if (op.p != null && o === 'append') st.lastPath = op.p; // shorthand {v:'…'} continues the last append
  if ((p === '' || p === '/') && o !== 'patch') {
    if (op.v && typeof op.v === 'object') Object.assign(root, op.v);
    return;
  }
  switch (o) {
    case 'append':
      ptrSet(root, p, (cur) => {
        if (Array.isArray(cur)) return cur.concat(Array.isArray(op.v) ? op.v : [op.v]);
        if (typeof cur === 'string' || cur == null) return (cur || '') + (typeof op.v === 'string' ? op.v : '');
        if (cur && typeof cur === 'object' && op.v && typeof op.v === 'object') return { ...cur, ...op.v };
        return cur;
      });
      break;
    case 'add':
    case 'replace':
      ptrSet(root, p, () => op.v);
      break;
    case 'remove':
      ptrSet(root, p, () => undefined);
      break;
    case 'patch':
      if (Array.isArray(op.v)) for (const sub of op.v) applyOp(st, root, sub);
      break;
    default:
      break;
  }
}

function assistantText(message) {
  if (!message || !message.content) return '';
  const c = message.content;
  if (Array.isArray(c.parts)) {
    return c.parts.map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object') return p.text || p.content || (p.asset_pointer ? `[attachment: ${p.asset_pointer}]` : '');
      return '';
    }).join('');
  }
  if (typeof c.text === 'string') return c.text;
  return '';
}

function ingestLine(st, line) {
  st.eventCount++;
  st.lastEventAt = Date.now();
  if (ctx?.pro && ctx?.settings?.vaultKeepRaw && st.raw.length < 5000) st.raw.push(line);
  if (line.startsWith('\u0000event:')) return;         // SSE event name, informational
  if (line === '[DONE]') { st.done = true; return; }
  let obj;
  try { obj = JSON.parse(line); } catch { return; }

  // Full message frame
  if (obj && obj.message && typeof obj.message === 'object') {
    st.root = obj;
    if (obj.conversation_id) st.conversationId = obj.conversation_id;
  } else if (obj && obj.v && typeof obj.v === 'object' && obj.v.message) {
    // delta_encoding v1 first frame
    st.root = obj.v;
    st.lastPath = '/message/content/parts/0';
    if (obj.v.conversation_id) st.conversationId = obj.v.conversation_id;
  } else if (obj && (obj.p != null || obj.o != null || typeof obj.v === 'string' || Array.isArray(obj.v))) {
    if (!st.root) st.root = { message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] } } };
    applyOp(st, st.root, obj);
  } else if (obj && obj.type === 'message_stream_complete') {
    st.done = true;
    if (obj.conversation_id) st.conversationId = obj.conversation_id;
  } else if (obj && obj.error) {
    st.status = 'error';
    st.note = typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error).slice(0, 300);
  }

  const msg = st.root?.message;
  if (msg) {
    const role = msg.author?.role;
    // Only track assistant output (skip tool/system frames); keep last assistant message seen.
    if (role === 'assistant' || role == null) {
      st.message = msg;
      if (msg.metadata?.model_slug) st.model = msg.metadata.model_slug;
    }
  }
  st.dirty = true;
}

// ---------- persistence ----------

function toEntry(st) {
  return {
    id: st.requestId,
    conversationId: st.conversationId || ctx.dom.conversationIdFromUrl(),
    messageId: st.message?.id || null,
    model: st.model,
    url: location.href,
    prompt: st.prompt,
    text: assistantText(st.message),
    status: st.status,
    startedAt: st.startedAt,
    updatedAt: Date.now(),
    endedAt: st.endedAt || null,
    eventCount: st.eventCount,
    raw: st.raw.length ? st.raw : undefined,
    note: st.note,
  };
}

function scheduleFlush(st, delay = 750) {
  if (st.flushTimer) return;
  st.flushTimer = setTimeout(() => { st.flushTimer = 0; flush(st); }, delay);
}
async function flush(st) {
  if (!st.dirty) return;
  st.dirty = false;
  try { await vault.put(toEntry(st)); } catch (e) { ctx.warn('vault put failed', e); }
}

// ---------- failure detection ----------

/** True once the stream carried a terminal frame, whatever happens to the socket afterwards. */
function sawFinalFrame(st) {
  const m = st.message;
  return !!(st.done || (m && (m.status === 'finished_successfully' || m.end_turn === true)));
}

/**
 * The page may abort its fetch controller as soon as it has the final frame, which errors our
 * branch of the tee and can drop the last bytes. Wait for the page to render, then take the
 * longer text from the DOM. Returns true when the entry ended up complete.
 */
async function reconcileWithDom(st) {
  await new Promise((r) => setTimeout(r, 2500));
  const captured = assistantText(st.message);
  const byId = st.message?.id ? document.querySelector(ctx.dom.SEL.messageById(st.message.id)) : null;
  const shown = byId ? (byId.innerText || byId.textContent || '').trim() : '';
  if (!shown) return false;
  const head = captured.replace(/\s+/g, ' ').trim().slice(0, 40);
  const matches = !head || shown.replace(/\s+/g, ' ').includes(head);
  if (!matches || shown.length < captured.length * 0.9) return false;
  try {
    const entry = toEntry(st);
    await vault.put({ ...entry, text: shown.length > captured.length ? shown : entry.text, status: 'complete', endedAt: Date.now(), note: entry.note ? entry.note + ' · completed from page' : 'Completed from page' });
  } catch {}
  return true;
}

function finish(st, status, note) {
  if (st.status !== 'streaming') { st.dirty = true; return flush(st); }
  st.status = status;
  st.endedAt = Date.now();
  if (note) st.note = note;
  st.dirty = true;
  clearTimeout(st.flushTimer); st.flushTimer = 0;
  streams.delete(st.requestId);
  return flush(st);
}

function checkStale() {
  const now = Date.now();
  for (const st of streams.values()) {
    if (st.status === 'streaming' && now - st.lastEventAt > ctx.constants.STALE_STREAM_MS) {
      const text = assistantText(st.message);
      finish(st, 'interrupted', 'No data for 30s (stuck processing)');
      if (text.length > 0) offerRecovery(st.requestId, 'Response seems stuck. The text received so far was saved.');
    }
  }
}

async function checkVanished(st) {
  const text = assistantText(st.message);
  if (!text) return;
  await new Promise((r) => setTimeout(r, ctx.constants.VANISH_CHECK_DELAY_MS));
  const urlConv = ctx.dom.conversationIdFromUrl();
  if (st.conversationId && urlConv && urlConv !== st.conversationId) return; // user navigated away

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const captured = norm(text);
  const byId = st.message?.id ? document.querySelector(ctx.dom.SEL.messageById(st.message.id)) : null;
  let reason = null;

  if (byId) {
    const shown = norm(byId.innerText || byId.textContent);
    if (shown.length / Math.max(1, captured.length) < 0.5) reason = 'The reply on screen is shorter than what was streamed.';
  } else {
    // No element with the message id: look for the captured text's opening in the last assistant message.
    const all = document.querySelectorAll(ctx.dom.SEL.assistantMessage);
    const last = all[all.length - 1];
    const shown = last ? norm(last.innerText || last.textContent) : '';
    const needle = captured.slice(0, 60);
    if (!shown.includes(needle)) reason = 'The reply vanished after streaming.';
  }

  if (reason) {
    try { await vault.put({ ...toEntry(st), status: 'vanished', endedAt: Date.now() }); } catch {}
    offerRecovery(st.requestId, reason);
  }
}

function offerRecovery(id, message) {
  ctx.ui.toast(message, {
    kind: 'warn',
    timeout: 15000,
    actions: [
      { label: 'Recover', primary: true, onClick: () => openVaultPanel(id) },
    ],
  });
}

// ---------- recovery UI ----------

async function openVaultPanel(focusId = null) {
  const { el, openPanel, copyText, download, fmtTime } = ctx.ui;
  const limit = ctx.pro ? 200 : ctx.constants.FREE_VAULT_LIMIT;
  let entries = [];
  try { entries = (await vault.list({ limit })) || []; } catch (e) { ctx.warn(e); }

  const list = el('div', { class: 'cgf-vault-list' });
  const detail = el('div', { class: 'cgf-vault-detail' });

  const search = el('input', { class: 'cgf-input', type: 'search', placeholder: ctx.pro ? 'Search captured responses…' : 'Search (Pro)', disabled: !ctx.pro });
  search.addEventListener('input', () => render(search.value));

  function render(q = '') {
    list.textContent = '';
    const needle = q.trim().toLowerCase();
    const shown = needle ? entries.filter((e) => (e.text || '').toLowerCase().includes(needle) || (e.prompt || '').toLowerCase().includes(needle)) : entries;
    if (!shown.length) list.append(el('p', { class: 'cgf-muted', text: 'No captured responses yet.' }));
    for (const e of shown) {
      const row = el('button', { class: 'cgf-vault-row' + (e.id === focusId ? ' cgf-vault-row-active' : ''), type: 'button' }, [
        el('span', { class: `cgf-badge cgf-badge-${e.status}`, text: e.status }),
        el('span', { class: 'cgf-vault-row-title', text: (e.prompt || e.text || '').slice(0, 80) || '(empty)' }),
        el('span', { class: 'cgf-muted cgf-vault-row-time', text: fmtTime(e.updatedAt) }),
      ]);
      row.addEventListener('click', () => { focusId = e.id; render(search.value); show(e); });
      list.append(row);
    }
  }

  function show(e) {
    detail.textContent = '';
    if (!e) return;
    const text = e.text || '(no text captured)';
    const actions = el('div', { class: 'cgf-row' }, [
      el('button', { class: 'cgf-btn cgf-btn-primary cgf-btn-small', type: 'button', text: 'Copy', onClick: async () => { (await copyText(text)) ? ctx.ui.toast('Copied') : ctx.ui.toast('Copy failed', { kind: 'error' }); } }),
      el('button', { class: 'cgf-btn cgf-btn-ghost cgf-btn-small', type: 'button', text: 'Insert into composer', onClick: () => { ctx.dom.insertIntoComposer(text) ? ctx.ui.toast('Inserted') : ctx.ui.toast('Composer not found', { kind: 'error' }); } }),
      el('button', { class: 'cgf-btn cgf-btn-ghost cgf-btn-small', type: 'button', text: 'Export .md', onClick: () => {
        if (!ctx.gate('Export')) return;
        download(`chatgpt-recovered-${new Date(e.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`, entryToMarkdown(e));
      } }),
      el('button', { class: 'cgf-btn cgf-btn-danger cgf-btn-small', type: 'button', text: 'Delete', onClick: async () => { await vault.delete(e.id); entries = entries.filter((x) => x.id !== e.id); detail.textContent = ''; render(search.value); } }),
    ]);
    const meta = el('p', { class: 'cgf-muted' }, [
      `${e.status} · ${fmtTime(e.startedAt)}${e.model ? ' · ' + e.model : ''}${e.note ? ' · ' + e.note : ''}`,
    ]);
    const promptBlock = e.prompt ? el('details', { class: 'cgf-details' }, [el('summary', { text: 'Prompt' }), el('pre', { class: 'cgf-pre', text: e.prompt })]) : null;
    detail.append(actions, meta, promptBlock, el('pre', { class: 'cgf-pre cgf-pre-main', text }));
  }

  const upsell = ctx.pro ? null : el('p', { class: 'cgf-muted cgf-upsell', text: `Free keeps the last ${ctx.constants.FREE_VAULT_LIMIT} responses. Pro (${ctx.constants.PRO_PRICE} once) keeps everything, adds search and export.` });

  openPanel({ title: 'Anti-Vanish vault', width: 520, content: [search, upsell, el('div', { class: 'cgf-vault' }, [list, detail])] });
  render();
  const first = entries.find((e) => e.id === focusId) || entries[0];
  if (first) { focusId = first.id; render(); show(first); }
}

// ---------- event wiring ----------

function onStreamEvent(e) {
  let p;
  try { p = JSON.parse(e.detail); } catch { return; }
  if (!p || !p.type) return;
  switch (p.type) {
    case 'ready':
      ctx.log('interceptor ready');
      break;
    case 'start': {
      const st = newStreamState(p.requestId, p.meta);
      streams.set(p.requestId, st);
      st.dirty = true;
      scheduleFlush(st, 300);
      break;
    }
    case 'data': {
      const st = streams.get(p.requestId); if (!st) return;
      for (const line of p.lines || []) ingestLine(st, line);
      scheduleFlush(st);
      break;
    }
    case 'done': {
      const st = streams.get(p.requestId); if (!st) return;
      const text = assistantText(st.message);
      const finalStatus = st.status === 'error' ? 'error' : (st.done || text.length > 0 ? 'complete' : 'interrupted');
      finish(st, finalStatus).then(() => { if (finalStatus === 'complete') checkVanished(st); });
      break;
    }
    case 'abort':
    case 'error':
    case 'nonstream': {
      const st = streams.get(p.requestId); if (!st) return;
      const text = assistantText(st.message);
      ctx.log('stream end', p.type, { final: sawFinalFrame(st), chars: text.length, events: st.eventCount, message: p.message });
      if (p.type === 'nonstream' || (p.type === 'abort' && sawFinalFrame(st))) {
        finish(st, 'complete').then(() => reconcileWithDom(st).then((ok) => { if (!ok) checkVanished(st); }));
        break;
      }
      const status = p.type === 'abort' ? 'interrupted' : 'error';
      finish(st, status, p.message).then(() => reconcileWithDom(st)).then((recovered) => {
        if (!recovered && text.length > 0) offerRecovery(st.requestId, p.type === 'abort' ? 'Generation was cut off. Partial text saved.' : 'The request failed. Partial text saved.');
      });
      break;
    }
  }
}

async function markOrphans() {
  try {
    const recent = (await vault.list({ limit: 20 })) || [];
    for (const e of recent) {
      if (e.status === 'streaming' && Date.now() - (e.updatedAt || 0) > 5000) {
        await vault.put({ ...e, status: 'interrupted', endedAt: Date.now(), note: 'Page reloaded mid-stream' });
      }
    }
  } catch {}
}

export default {
  id: 'antiVanish',

  async init(c) {
    ctx = c;
    const mod = await import(chrome.runtime.getURL('src/content/isolated/db/stream-vault.js'));
    VaultClient = mod.VaultClient; entryToMarkdown = mod.entryToMarkdown;
    vault = new VaultClient(ctx.send);
    listener = onStreamEvent;
    window.addEventListener(ctx.constants.EVENTS.STREAM, listener);
    staleTimer = setInterval(checkStale, 5000);
    markOrphans();
    // Expose for other modules/popup command
    window.__cgfOpenVault = openVaultPanel;
  },

  destroy() {
    if (listener) window.removeEventListener(ctx.constants.EVENTS.STREAM, listener);
    clearInterval(staleTimer);
    for (const st of streams.values()) { clearTimeout(st.flushTimer); }
    streams.clear();
    delete window.__cgfOpenVault;
    ctx.ui.closePanel();
  },

  onCommand(cmd) {
    if (cmd === 'open-vault') openVaultPanel();
  },
};

/** Test hooks (pure functions; no DOM/chrome needed). */
export const __test = { newStreamState, ingestLine, assistantText, applyOp };

// MAIN-world content script, runs at document_start on https://chatgpt.com/*.
// Wraps window.fetch so streaming replies on /backend-api/conversation can be mirrored to the
// ISOLATED world via CustomEvents. It is PASSIVE until the isolated side flips
// <html data-cgf-stream="on"> (set only after consent + Anti-Vanish enabled).
//
// Nothing here touches storage or the network; it only tees a stream the page already requested.
// Classic script (no imports). Keep EVENT names in sync with src/shared/constants.js.
(() => {
  if (window.__cgfInterceptorInstalled) return;
  window.__cgfInterceptorInstalled = true;

  const EVENT_STREAM = 'cgf:stream';
  const EVENT_CONTROL = 'cgf:control';
  const EVENT_READY = 'cgf:interceptor-ready';
  const FLAG_ATTR = 'data-cgf-stream';
  const ENDPOINT_RE = /\/backend-(?:api|alt)\/(?:f\/)?conversation$/;
  const BATCH_MS = 60;        // coalesce SSE lines into one event per ~60ms
  const MAX_PROMPT_CHARS = 2000;

  let enabledByEvent = null; // null = unknown, use attribute
  window.addEventListener(EVENT_CONTROL, (e) => {
    try {
      const d = JSON.parse(e.detail);
      if (typeof d.enabled === 'boolean') enabledByEvent = d.enabled;
    } catch {}
  });

  const isEnabled = () => {
    if (enabledByEvent !== null) return enabledByEvent;
    return document.documentElement.getAttribute(FLAG_ATTR) === 'on';
  };

  const emit = (payload) => {
    try { window.dispatchEvent(new CustomEvent(EVENT_STREAM, { detail: JSON.stringify(payload) })); } catch {}
  };

  let seq = 0;
  const newId = () => `${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  function describe(input, init) {
    let url, method = 'GET', body = null;
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.href;
    else if (input && typeof input === 'object' && 'url' in input) { url = input.url; method = input.method || method; }
    if (init) {
      if (init.method) method = init.method;
      if (init.body != null) body = init.body;
    }
    if (!url) return null;
    let pathname;
    try { pathname = new URL(url, location.origin).pathname; } catch { return null; }
    if (method.toUpperCase() !== 'POST' || !ENDPOINT_RE.test(pathname)) return null;
    return { url, pathname, body };
  }

  function extractRequestMeta(body) {
    const meta = { prompt: '', conversationId: null, parentMessageId: null, model: null, action: null };
    try {
      const text = typeof body === 'string' ? body : null;
      if (!text) return meta;
      const j = JSON.parse(text);
      meta.conversationId = j.conversation_id || null;
      meta.parentMessageId = j.parent_message_id || null;
      meta.model = j.model || null;
      meta.action = j.action || null;
      const msgs = Array.isArray(j.messages) ? j.messages : [];
      const parts = [];
      for (const m of msgs) {
        const p = m && m.content && Array.isArray(m.content.parts) ? m.content.parts : [];
        for (const part of p) if (typeof part === 'string') parts.push(part);
      }
      meta.prompt = parts.join('\n').slice(0, MAX_PROMPT_CHARS);
    } catch {}
    return meta;
  }

  async function pump(stream, requestId) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let batch = [];
    let timer = 0;
    let count = 0;

    const flush = () => {
      timer = 0;
      if (!batch.length) return;
      emit({ type: 'data', requestId, lines: batch, t: Date.now() });
      batch = [];
    };
    const queue = (line) => {
      batch.push(line);
      count++;
      if (!timer) timer = setTimeout(flush, BATCH_MS);
    };
    const handleChunk = (text) => {
      buf += text;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) queue(line.slice(5).trimStart());
        else if (line.startsWith('event:')) queue('\u0000event:' + line.slice(6).trim());
      }
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        handleChunk(decoder.decode(value, { stream: true }));
      }
      handleChunk(decoder.decode());
      if (buf.trim().startsWith('data:')) queue(buf.trim().slice(5).trimStart());
      flush();
      emit({ type: 'done', requestId, count, t: Date.now() });
    } catch (err) {
      // An abort drops whatever was still buffered; keep the partial line we do have.
      if (buf.trim().startsWith('data:')) queue(buf.trim().slice(5).trimStart());
      flush();
      const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message)));
      emit({ type: aborted ? 'abort' : 'error', requestId, count, message: String(err && err.message || err), t: Date.now() });
    }
  }

  const origFetch = window.fetch;
  const wrapped = async function cgfFetch(input, init) {
    let info = null;
    try { if (isEnabled()) info = describe(input, init); } catch {}

    const response = await origFetch.apply(this, arguments);
    if (!info) return response;

    try {
      const requestId = newId();
      const meta = extractRequestMeta(info.body);
      const ct = (response.headers.get('content-type') || '').toLowerCase();

      emit({ type: 'start', requestId, url: info.pathname, status: response.status, contentType: ct, meta, t: Date.now() });

      if (!response.ok || !response.body || !ct.includes('text/event-stream')) {
        emit({ type: response.ok ? 'nonstream' : 'error', requestId, status: response.status, message: `HTTP ${response.status}`, t: Date.now() });
        return response;
      }

      const [toPage, toUs] = response.body.tee();
      pump(toUs, requestId);

      const proxied = new Response(toPage, { status: response.status, statusText: response.statusText, headers: response.headers });
      // Preserve fields the page might read that the Response constructor drops.
      try { Object.defineProperty(proxied, 'url', { value: response.url, configurable: true }); } catch {}
      try { Object.defineProperty(proxied, 'type', { value: response.type, configurable: true }); } catch {}
      try { Object.defineProperty(proxied, 'redirected', { value: response.redirected, configurable: true }); } catch {}
      return proxied;
    } catch {
      return response; // never break the page
    }
  };

  try {
    Object.defineProperty(wrapped, 'name', { value: 'fetch' });
    wrapped.toString = () => origFetch.toString();
  } catch {}
  window.fetch = wrapped;

  emit({ type: 'ready', t: Date.now() });
  try { window.dispatchEvent(new CustomEvent(EVENT_READY)); } catch {}
})();

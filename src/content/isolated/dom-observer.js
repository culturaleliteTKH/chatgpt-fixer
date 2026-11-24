// Central place for ChatGPT DOM knowledge. Every module goes through here so a frontend change
// means editing one file. Prefer data-testid / ARIA / structure; never Tailwind class names.

export const SEL = {
  // Messages
  message: '[data-message-author-role]',
  messageById: (id) => `[data-message-id="${cssEscape(id)}"]`,
  assistantMessage: '[data-message-author-role="assistant"]',
  userMessage: '[data-message-author-role="user"]',
  turn: 'article[data-testid^="conversation-turn"], [data-testid^="conversation-turn"]',

  // Composer
  composer: '#prompt-textarea, [data-testid="prompt-textarea"], form textarea, form [contenteditable="true"]',
  composerForm: 'form[data-type="unified-composer"], main form',
  sendButton: '[data-testid="send-button"], button[aria-label*="Send" i]',
  stopButton: '[data-testid="stop-button"], button[aria-label*="Stop" i]',

  // Sidebar / navigation
  sidebar: 'nav[aria-label], #stage-slideover-sidebar, nav',
  sidebarToggle: [
    '[data-testid="close-sidebar-button"]',
    '[data-testid="open-sidebar-button"]',
    'button[aria-label*="sidebar" i]',
    'button[aria-label*="Close sidebar" i]',
    'button[aria-label*="Open sidebar" i]',
  ].join(', '),
  newChat: '[data-testid="create-new-chat-button"], a[href="/"], a[aria-label*="New chat" i], button[aria-label*="New chat" i]',
  chatLink: 'a[href^="/c/"], a[href^="/g/"][href*="/c/"]',
  chatItemOptions: 'button[aria-haspopup="menu"], [data-testid$="options"], button[aria-label*="options" i], button[aria-label*="More" i]',
  menu: '[role="menu"]',
  menuItem: '[role="menuitem"]',
  dialog: '[role="dialog"]',

  // Quotes / references
  quote: 'blockquote, [data-testid*="quote" i], [aria-label*="quote" i], [data-quote]',
};

export function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

/**
 * Match a keydown against a combo like "Alt+S". Uses e.code for the letter so it works on macOS,
 * where Option+letter changes e.key to a symbol (Option+B gives "∫").
 */
export function matchesShortcut(e, combo) {
  if (!combo) return false;
  const parts = combo.toLowerCase().split('+').map((s) => s.trim());
  const key = parts.pop();
  const want = {
    alt: parts.includes('alt') || parts.includes('option'),
    ctrl: parts.includes('ctrl') || parts.includes('control'),
    shift: parts.includes('shift'),
    meta: parts.includes('cmd') || parts.includes('meta') || parts.includes('command'),
  };
  if (e.altKey !== want.alt || e.ctrlKey !== want.ctrl || e.shiftKey !== want.shift || e.metaKey !== want.meta) return false;
  if (/^[a-z]$/.test(key)) return e.code === `Key${key.toUpperCase()}` || e.key.toLowerCase() === key;
  if (/^[0-9]$/.test(key)) return e.code === `Digit${key}` || e.key === key;
  return e.key.toLowerCase() === key;
}

/** Compact one-line description of an element: tag plus the attributes that matter for selectors. */
export function describeEl(el) {
  if (!(el instanceof Element)) return String(el);
  const keep = ['id', 'role', 'type', 'href', 'contenteditable', 'aria-label', 'aria-haspopup', 'aria-expanded', 'title', 'name', 'placeholder'];
  const parts = [el.tagName.toLowerCase()];
  for (const a of el.attributes) {
    if (keep.includes(a.name) || a.name.startsWith('data-')) {
      let v = a.value;
      if (a.name === 'href') v = v.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '<id>');
      parts.push(`${a.name}="${v.slice(0, 60)}"`);
    }
  }
  const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
  if (cls) parts.push(`class="${cls}${el.classList.length > 4 ? ' …' : ''}"`);
  return `<${parts.join(' ')}>`;
}

/** Ancestor chain from `el` upward, closest first. Text content is never included. */
export function describeChain(el, depth = 6) {
  const out = [];
  let cur = el;
  while (cur && cur !== document.body && out.length < depth) { out.push(describeEl(cur)); cur = cur.parentElement; }
  return out;
}

/** Shallow outline of a subtree (tags and attributes only). */
export function describeTree(el, depth = 3, maxChildren = 8, indent = '') {
  if (!(el instanceof Element)) return [];
  const lines = [indent + describeEl(el)];
  if (depth <= 0) return lines;
  const kids = Array.from(el.children);
  for (const k of kids.slice(0, maxChildren)) lines.push(...describeTree(k, depth - 1, maxChildren, indent + '  '));
  if (kids.length > maxChildren) lines.push(`${indent}  … ${kids.length - maxChildren} more`);
  return lines;
}

export function cssEscape(s) {
  return (globalThis.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&');
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function debounce(fn, ms) {
  let t = 0;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** Shared, debounced MutationObserver. Modules subscribe instead of each creating their own. */
const subscribers = new Set();
let observer = null;
let pending = false;

function flush() {
  pending = false;
  for (const cb of subscribers) {
    try { cb(); } catch (e) { console.warn('[cgf] mutation subscriber failed', e); }
  }
}
const scheduleFlush = debounce(flush, 150);

export function onMutation(cb) {
  subscribers.add(cb);
  if (!observer) {
    observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      scheduleFlush();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && observer) { observer.disconnect(); observer = null; }
  };
}

/** Resolve when `sel` appears (or immediately if present). Rejects on timeout. */
export function waitFor(sel, { timeout = 8000, root = document } = {}) {
  return new Promise((resolve, reject) => {
    const found = root.querySelector(sel);
    if (found) return resolve(found);
    const mo = new MutationObserver(() => {
      const el = root.querySelector(sel);
      if (el) { mo.disconnect(); clearTimeout(t); resolve(el); }
    });
    mo.observe(root === document ? document.documentElement : root, { childList: true, subtree: true });
    const t = setTimeout(() => { mo.disconnect(); reject(new Error(`timeout waiting for ${sel}`)); }, timeout);
  });
}

/** SPA navigation hook (pushState/replaceState/popstate + polling fallback). */
const navSubs = new Set();
let lastHref = location.href;
let navTimer = 0;
function checkNav() {
  if (location.href !== lastHref) {
    lastHref = location.href;
    for (const cb of navSubs) { try { cb(location.href); } catch {} }
  }
}
export function onNavigate(cb) {
  navSubs.add(cb);
  if (!navTimer) {
    window.addEventListener('popstate', checkNav);
    navTimer = setInterval(checkNav, 500);
  }
  return () => {
    navSubs.delete(cb);
    if (navSubs.size === 0) { clearInterval(navTimer); navTimer = 0; window.removeEventListener('popstate', checkNav); }
  };
}

export function conversationIdFromUrl(href = location.href) {
  const m = /\/c\/([a-zA-Z0-9-]+)/.exec(href);
  return m ? m[1] : null;
}

export function conversationTitle() {
  const t = document.title.replace(/\s*[-|–]\s*ChatGPT\s*$/i, '').trim();
  return t && t.toLowerCase() !== 'chatgpt' ? t : 'Untitled conversation';
}

/** Visible messages as {role, text, id} in document order. */
export function readMessages() {
  return $$(SEL.message).map((el) => ({
    id: el.getAttribute('data-message-id') || null,
    role: el.getAttribute('data-message-author-role') || 'unknown',
    text: (el.innerText || el.textContent || '').trim(),
    el,
  })).filter((m) => m.text.length > 0);
}

/** Find the composer element (textarea or contenteditable). */
export function composer() {
  return $(SEL.composer);
}

/** Insert text into the composer, supporting both textarea and ProseMirror-style contenteditable. */
export function insertIntoComposer(text) {
  const c = composer();
  if (!c) return false;
  c.focus();
  if (c instanceof HTMLTextAreaElement) {
    const start = c.selectionStart ?? c.value.length;
    c.setRangeText(text, start, c.selectionEnd ?? start, 'end');
    c.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  // contenteditable: execCommand keeps the editor's own model in sync
  try {
    const ok = document.execCommand('insertText', false, text);
    if (ok) return true;
  } catch {}
  c.textContent = (c.textContent || '') + text;
  c.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  return true;
}

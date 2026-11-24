// Classic navigation: middle-click / Ctrl(Cmd)-click on "New chat" and sidebar items opens a new tab,
// plus a predictable sidebar toggle (Alt+S by default, also via the extension command).

let ctx = null;
let handlers = [];
let lastKeyHandled = 0;

function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  handlers.push(() => target.removeEventListener(type, fn, opts));
}

function hrefFor(target) {
  const { SEL } = ctx.dom;
  const a = target.closest('a[href]');
  if (a) {
    const href = a.getAttribute('href');
    if (href && (href.startsWith('/') || href.startsWith(location.origin))) return new URL(href, location.origin).href;
  }
  if (target.closest(SEL.newChat)) return location.origin + '/';
  // Items rendered as non-anchors sometimes carry the id in a data attribute
  const holder = target.closest('[data-conversation-id], [data-id^="conversation-"], [data-href]');
  if (holder) {
    const h = holder.getAttribute('data-href');
    if (h) return new URL(h, location.origin).href;
    const id = holder.getAttribute('data-conversation-id') || (holder.getAttribute('data-id') || '').replace(/^conversation-/, '');
    if (id) return `${location.origin}/c/${id}`;
  }
  return null;
}

function inNavArea(target) {
  const { SEL } = ctx.dom;
  return !!(target.closest(SEL.sidebar) || target.closest(SEL.newChat) || target.closest(SEL.dialog) || target.closest(SEL.chatLink));
}

function openNewTab(href) {
  const w = window.open(href, '_blank', 'noopener');
  if (!w) ctx.ui.toast('Popup blocked — allow popups for chatgpt.com to open chats in new tabs.', { kind: 'warn' });
}

function handlePointer(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || !inNavArea(t)) return;
  const middle = e.button === 1;
  const modified = e.button === 0 && (e.ctrlKey || e.metaKey);
  if (!middle && !modified) return;
  const href = hrefFor(t);
  if (!href) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.type === 'auxclick' || e.type === 'click') openNewTab(href);
}

function toggleSidebar() {
  const candidates = ctx.dom.$$(ctx.dom.SEL.sidebarToggle).filter(ctx.dom.isVisible);
  // Prefer an explicit close button when the sidebar is open; several buttons can match.
  const label = (b) => b.getAttribute('aria-label') || b.getAttribute('data-testid') || '';
  const btn = candidates.find((b) => /close/i.test(label(b)))
    || candidates.find((b) => /open|toggle/i.test(label(b)))
    || candidates[0];
  if (btn) { btn.click(); return true; }
  ctx.ui.toast('Sidebar toggle button not found (ChatGPT UI may have changed).', { kind: 'warn' });
  return false;
}

function onKey(e) {
  if (!ctx.settings.shortcuts.inPage) return;
  if (ctx.dom.matchesShortcut(e, ctx.settings.shortcuts.toggleSidebar)) {
    e.preventDefault();
    e.stopPropagation();
    lastKeyHandled = Date.now();
    toggleSidebar();
  }
}

export default {
  id: 'navTabs',
  init(c) {
    ctx = c;
    // Capture phase so we beat the site's React handlers; mousedown/pointerdown stop its own navigation.
    for (const type of ['pointerdown', 'mousedown', 'auxclick', 'click']) on(document, type, handlePointer, { capture: true });
    on(document, 'keydown', onKey, { capture: true });
  },
  destroy() { handlers.forEach((off) => off()); handlers = []; },
  onCommand(cmd) {
    if (cmd !== ctx.constants.COMMANDS.TOGGLE_SIDEBAR) return;
    if (Date.now() - lastKeyHandled < 300) return; // in-page shortcut already handled it
    toggleSidebar();
  },
};

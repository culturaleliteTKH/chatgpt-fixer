// Tiny DOM helpers + toast / panel primitives. All classes are .cgf-* and scoped in fixer.css.

export function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v; // only ever called with our own static markup
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

export function icon(name = 'shield-check', size = 16) {
  const img = el('img', { class: 'cgf-icon', alt: '', width: size, height: size, 'aria-hidden': 'true' });
  try { img.src = chrome.runtime.getURL(`assets/icons/${name}.svg`); } catch {}
  return img;
}

let toastHost = null;
function host() {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = el('div', { class: 'cgf-root cgf-toast-host', role: 'status', 'aria-live': 'polite' });
    document.documentElement.append(toastHost);
  }
  return toastHost;
}

/**
 * toast('Saved', { actions: [{ label: 'Undo', onClick }], timeout: 6000, kind: 'info'|'warn'|'error' })
 * Returns a function that dismisses the toast.
 */
export function toast(message, { actions = [], timeout = 6000, kind = 'info' } = {}) {
  const node = el('div', { class: `cgf-toast cgf-toast-${kind}` }, [
    el('span', { class: 'cgf-toast-msg', text: message }),
  ]);
  const dismiss = () => { node.classList.add('cgf-toast-out'); setTimeout(() => node.remove(), 200); };
  if (actions.length) {
    const row = el('div', { class: 'cgf-toast-actions' });
    for (const a of actions) {
      row.append(el('button', {
        class: 'cgf-btn cgf-btn-small ' + (a.primary ? 'cgf-btn-primary' : 'cgf-btn-ghost'),
        type: 'button',
        text: a.label,
        onClick: () => { try { a.onClick?.(); } finally { if (!a.keepOpen) dismiss(); } },
      }));
    }
    node.append(row);
  }
  node.append(el('button', { class: 'cgf-toast-close', type: 'button', 'aria-label': 'Dismiss', text: '×', onClick: dismiss }));
  host().append(node);
  if (timeout > 0) setTimeout(dismiss, timeout);
  return dismiss;
}

let panelNode = null;
/** Slide-in side panel. `content` is a Node or array of Nodes. Only one panel at a time. */
export function openPanel({ title, content, width = 420 }) {
  closePanel();
  const body = el('div', { class: 'cgf-panel-body' }, content);
  panelNode = el('aside', { class: 'cgf-root cgf-panel', role: 'complementary', 'aria-label': title, style: `width:${width}px` }, [
    el('header', { class: 'cgf-panel-head' }, [
      icon('shield-check', 18),
      el('h2', { class: 'cgf-panel-title', text: title }),
      el('button', { class: 'cgf-panel-close', type: 'button', 'aria-label': 'Close', text: '×', onClick: closePanel }),
    ]),
    body,
  ]);
  document.documentElement.append(panelNode);
  const onKey = (e) => { if (e.key === 'Escape') { closePanel(); } };
  document.addEventListener('keydown', onKey, { capture: true });
  panelNode._cleanup = () => document.removeEventListener('keydown', onKey, { capture: true });
  return { body, close: closePanel };
}

export function closePanel() {
  if (panelNode) { panelNode._cleanup?.(); panelNode.remove(); panelNode = null; }
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const ta = el('textarea', { style: 'position:fixed;opacity:0;left:-9999px' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

export function download(filename, text, mime = 'text/markdown') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}

export function flash(target) {
  target.classList.add('cgf-flash');
  setTimeout(() => target.classList.remove('cgf-flash'), 1600);
}

export function fmtTime(ts) {
  try { return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(ts); }
}

export function fmtTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

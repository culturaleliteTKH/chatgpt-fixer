// Quote jump: clicking a quoted/referenced passage scrolls to the message it came from and flashes it.
// Works by text matching, so it survives markup changes as long as messages keep data-message-author-role.

let ctx = null;
let off = null;
let unsubMutation = null;

const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

function quotedText(quoteEl) {
  const t = (quoteEl.innerText || quoteEl.textContent || '').trim();
  return t.length > 160 ? t.slice(0, 160) : t;
}

function findSource(quoteEl, text) {
  const needle = norm(text);
  if (needle.length < 8) return null;
  const myMsg = quoteEl.closest(ctx.dom.SEL.message);
  const candidates = ctx.dom.$$(ctx.dom.SEL.message).filter((m) => m !== myMsg);
  // Prefer the closest earlier message containing the text
  let best = null;
  for (const m of candidates) {
    const hay = norm(m.innerText || m.textContent || '');
    if (hay.includes(needle)) {
      if (myMsg && m.compareDocumentPosition(myMsg) & Node.DOCUMENT_POSITION_FOLLOWING) best = m; // m is before myMsg
      else if (!best) best = m;
    }
  }
  return best;
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const q = t.closest(ctx.dom.SEL.quote);
  if (!q || !q.closest(ctx.dom.SEL.message)) return;
  if (t.closest('a[href], button')) return; // let real links/buttons work
  const text = quotedText(q);
  const src = findSource(q, text);
  if (!src) return;
  e.preventDefault();
  src.scrollIntoView({ behavior: 'smooth', block: 'center' });
  ctx.ui.flash(src);
}

function decorate() {
  for (const q of ctx.dom.$$(ctx.dom.SEL.quote)) {
    if (!q.closest(ctx.dom.SEL.message) || q.dataset.cgfQuote) continue;
    q.dataset.cgfQuote = '1';
    q.classList.add('cgf-quote');
    q.title = 'Jump to source message';
  }
}

export default {
  id: 'quoteJump',
  init(c) {
    ctx = c;
    document.addEventListener('click', onClick, true);
    off = () => document.removeEventListener('click', onClick, true);
    unsubMutation = ctx.dom.onMutation(decorate);
    decorate();
  },
  destroy() {
    off?.(); unsubMutation?.();
    for (const q of ctx.dom.$$('[data-cgf-quote]')) { delete q.dataset.cgfQuote; q.classList.remove('cgf-quote'); q.removeAttribute('title'); }
  },
};

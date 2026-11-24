// Context meter & branch handoff.
//   Meter: local token estimate for the visible thread, rendered above the composer.
//   Branch (Alt+B): package the last N messages into a handoff prompt for a fresh chat.
//     Free: copies the handoff (last 3 messages) to the clipboard and opens a new chat.
//     Pro:  one-click — opens the new chat with the prompt pre-filled (?q=) when it fits, custom
//           template, and depth up to HANDOFF_MAX_DEPTH.

let ctx = null;
let meterEl = null;
let unsubMutation = null;
let unsubNav = null;
let handlers = [];
let lastKeyHandled = 0;

function on(target, type, fn, opts) { target.addEventListener(type, fn, opts); handlers.push(() => target.removeEventListener(type, fn, opts)); }

/** Cheap local estimate: ~3.8 chars/token for prose, heavier for code-ish text. */
export function estimateTokens(text) {
  if (!text) return 0;
  const codeish = (text.match(/[{}[\]();=<>\/\\|`]/g) || []).length;
  const ratio = codeish / Math.max(1, text.length) > 0.03 ? 3.0 : 3.8;
  return Math.ceil(text.length / ratio);
}

function threadStats() {
  const msgs = ctx.dom.readMessages();
  const chars = msgs.reduce((n, m) => n + m.text.length, 0);
  const tokens = estimateTokens(msgs.map((m) => m.text).join('\n')) + msgs.length * 4; // per-message overhead
  return { msgs, chars, tokens };
}

function renderMeter() {
  if (!ctx.settings.showMeter) { meterEl?.remove(); meterEl = null; return; }
  const composer = ctx.dom.composer();
  const form = composer?.closest('form') || document.querySelector(ctx.dom.SEL.composerForm);
  if (!form) return;
  const { tokens, msgs } = threadStats();
  if (!msgs.length) { meterEl?.remove(); meterEl = null; return; }
  const max = Math.max(1000, Number(ctx.settings.contextWindow) || 128000);
  const pct = Math.min(100, Math.round((tokens / max) * 100));
  const level = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok';

  if (!meterEl || !meterEl.isConnected) {
    meterEl = ctx.ui.el('button', { class: 'cgf-root cgf-meter', type: 'button', title: 'Estimated context usage — click to branch into a new chat' });
    meterEl.addEventListener('click', () => branch());
    form.parentElement?.insertBefore(meterEl, form);
  }
  meterEl.dataset.level = level;
  meterEl.textContent = '';
  const bar = ctx.ui.el('span', { class: 'cgf-meter-bar' }, [ctx.ui.el('span', { class: 'cgf-meter-fill', style: `width:${pct}%` })]);
  meterEl.append(
    bar,
    ctx.ui.el('span', { class: 'cgf-meter-label', text: `~${ctx.ui.fmtTokens(tokens)} / ${ctx.ui.fmtTokens(max)} tokens · ${pct}%` }),
    ctx.ui.el('span', { class: 'cgf-meter-cta', text: pct >= 70 ? 'Branch →' : 'Branch' }),
  );
}

function buildHandoff() {
  const { DEFAULT_HANDOFF_TEMPLATE, FREE_HANDOFF_DEPTH, HANDOFF_MAX_DEPTH } = ctx.constants;
  const { msgs } = threadStats();
  const depth = ctx.pro ? Math.min(HANDOFF_MAX_DEPTH, Math.max(1, Number(ctx.settings.handoffDepth) || FREE_HANDOFF_DEPTH)) : FREE_HANDOFF_DEPTH;
  const recent = msgs.slice(-depth);
  const perMsgCap = ctx.pro ? 6000 : 2500;
  const messages = recent.map((m) => {
    const who = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
    const t = m.text.length > perMsgCap ? m.text.slice(0, perMsgCap) + ' …[truncated]' : m.text;
    return `### ${who}\n${t}`;
  }).join('\n\n');
  const template = (ctx.pro && ctx.settings.handoffTemplate?.trim()) || DEFAULT_HANDOFF_TEMPLATE;
  return template
    .replaceAll('{title}', ctx.dom.conversationTitle())
    .replaceAll('{url}', location.href)
    .replaceAll('{messages}', messages)
    .replaceAll('{date}', new Date().toISOString().slice(0, 10))
    .replaceAll('{count}', String(recent.length));
}

async function branch() {
  lastKeyHandled = Date.now();
  const text = buildHandoff();
  if (!text.trim()) { ctx.ui.toast('Nothing to hand off yet.', { kind: 'warn' }); return; }
  const copied = await ctx.ui.copyText(text);

  if (ctx.pro) {
    const q = encodeURIComponent(text);
    const url = q.length < 7000 ? `${location.origin}/?q=${q}` : `${location.origin}/`;
    window.open(url, '_blank', 'noopener');
    ctx.ui.toast(q.length < 7000 ? 'Branched — new chat opened with the handoff pre-filled.' : 'Branched — handoff copied; paste it into the new chat.', { timeout: 6000 });
  } else {
    window.open(`${location.origin}/`, '_blank', 'noopener');
    ctx.ui.toast(copied ? `Handoff (last ${ctx.constants.FREE_HANDOFF_DEPTH} messages) copied. Paste it into the new chat. Pro pre-fills it for you.` : 'Could not copy to clipboard.', { kind: copied ? 'info' : 'error', timeout: 8000 });
  }
}

function onKey(e) {
  if (!ctx.settings.shortcuts.inPage) return;
  if (ctx.dom.matchesShortcut(e, ctx.settings.shortcuts.branchChat)) { e.preventDefault(); e.stopPropagation(); branch(); }
}

export default {
  id: 'contextHandoff',
  init(c) {
    ctx = c;
    const schedule = ctx.dom.debounce(renderMeter, 600);
    unsubMutation = ctx.dom.onMutation(schedule);
    unsubNav = ctx.dom.onNavigate(() => { meterEl?.remove(); meterEl = null; schedule(); });
    on(document, 'keydown', onKey, { capture: true });
    renderMeter();
  },
  destroy() {
    unsubMutation?.(); unsubNav?.(); handlers.forEach((f) => f()); handlers = [];
    meterEl?.remove(); meterEl = null;
  },
  onSettings() { renderMeter(); },
  onCommand(cmd) {
    if (cmd !== ctx.constants.COMMANDS.BRANCH_CHAT) return;
    if (Date.now() - lastKeyHandled < 300) return;
    branch();
  },
};

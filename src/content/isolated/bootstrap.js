// ISOLATED-world entry point (classic script; runs at document_idle).
// Loads shared ES modules via dynamic import, then manages module lifecycles:
//   - each module is `{ id, init(ctx), destroy(), onCommand?(cmd), onNavigate?(href) }`
//   - every call is wrapped in try/catch so one broken module never takes the others down
//   - settings changes (popup toggles, consent, Pro) re-sync live without a page reload
(async () => {
  if (window.__cgfBootstrapped) return;
  window.__cgfBootstrapped = true;

  const url = (p) => chrome.runtime.getURL(p);
  const log = (...a) => { if (state.settings?.debug) console.debug('[cgf]', ...a); };
  const warn = (...a) => console.warn('[cgf]', ...a);

  let constants, storage, consent, license, dom, ui;
  try {
    [constants, storage, consent, license, dom, ui] = await Promise.all([
      import(url('src/shared/constants.js')),
      import(url('src/shared/storage.js')),
      import(url('src/shared/consent.js')),
      import(url('src/shared/license.js')),
      import(url('src/content/isolated/dom-observer.js')),
      import(url('src/content/isolated/ui.js')),
    ]);
  } catch (e) {
    return warn('failed to load core modules', e);
  }

  const { MODULES, MSG, STREAM_FLAG_ATTR, EVENTS } = constants;

  const state = { settings: null, consent: null, pro: false };
  const registry = new Map(); // id -> { def, mod, active }
  for (const def of MODULES) registry.set(def.id, { def, mod: null, active: false, error: null });

  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) { log('sendMessage error', chrome.runtime.lastError.message); return resolve(undefined); }
        resolve(res);
      });
    } catch (e) { resolve(undefined); }
  });

  /** Shared context handed to every module. */
  const ctx = {
    constants, storage, consent, license, dom, ui, send, log, warn,
    get settings() { return state.settings; },
    get pro() { return state.pro; },
    get consentOk() { return consent.hasValidConsent(state.consent); },
    gate(featureLabel) {
      if (state.pro) return true;
      ui.toast(`${featureLabel} is a Pro feature (${constants.PRO_PRICE}, one-time). Unlock it from the extension popup.`, { kind: 'info', timeout: 7000 });
      return false;
    },
  };

  async function loadModule(entry) {
    if (entry.mod) return entry.mod;
    try {
      const m = await import(url(`src/content/isolated/modules/${entry.def.file}`));
      entry.mod = m.default || m;
      return entry.mod;
    } catch (e) {
      entry.error = `load: ${e && e.message || e}`;
      warn(`module ${entry.def.id} failed to load`, e);
      return null;
    }
  }

  async function activate(entry) {
    const mod = await loadModule(entry);
    if (!mod || entry.active) return;
    try {
      await mod.init(ctx);
      entry.active = true;
      entry.error = null;
      log('module up:', entry.def.id);
    } catch (e) {
      entry.error = `init: ${e && e.message || e}`;
      warn(`module ${entry.def.id} init failed`, e);
      try { mod.destroy?.(); } catch {}
    }
  }

  function deactivate(entry) {
    if (!entry.active) return;
    try { entry.mod?.destroy?.(); } catch (e) { warn(`module ${entry.def.id} destroy failed`, e); }
    entry.active = false;
    log('module down:', entry.def.id);
  }

  function updateStreamFlag() {
    const on = ctx.consentOk && !!state.settings?.modules?.antiVanish;
    document.documentElement.setAttribute(STREAM_FLAG_ATTR, on ? 'on' : 'off');
    try { window.dispatchEvent(new CustomEvent(EVENTS.CONTROL, { detail: JSON.stringify({ enabled: on }) })); } catch {}
  }

  let consentShowing = false;
  function maybeShowConsent() {
    if (consentShowing || consent.hasDecided(state.consent)) return;
    const needs = MODULES.some((d) => d.needsConsent && state.settings.modules[d.id]);
    if (!needs) return;
    consentShowing = true;
    const modal = consent.renderConsentModal(document, {
      onAccept: async () => { consentShowing = false; await consent.setConsent(true); },
      onDecline: async () => { consentShowing = false; await consent.setConsent(false); },
    });
    document.documentElement.append(modal);
  }

  async function sync() {
    try {
      [state.settings, state.consent, state.pro] = await Promise.all([
        storage.getSettings(), consent.getConsent(), license.isPro(),
      ]);
    } catch (e) { return warn('sync failed', e); }

    updateStreamFlag();
    maybeShowConsent();

    for (const entry of registry.values()) {
      const enabled = !!state.settings.modules[entry.def.id];
      const allowed = !entry.def.needsConsent || ctx.consentOk;
      const want = enabled && allowed;
      if (want && !entry.active) await activate(entry);
      else if (!want && entry.active) deactivate(entry);
      else if (entry.active) { try { entry.mod.onSettings?.(state.settings); } catch {} }
    }
  }

  storage.onChanged(() => { sync(); });

  /** Structure-only snapshot of the parts of the page the modules depend on. No message text. */
  function diagnostics() {
    const { SEL, $, $$, describeChain, describeTree } = dom;
    const counts = {};
    for (const [name, sel] of Object.entries(SEL)) if (typeof sel === 'string') { try { counts[name] = $$(sel).length; } catch (e) { counts[name] = `invalid: ${e.message}`; } }
    const composer = dom.composer();
    const firstChat = $(SEL.chatLink);
    const sidebar = $(SEL.sidebar);
    const msg = $(SEL.message);
    const report = {
      version: chrome.runtime.getManifest().version,
      ua: navigator.userAgent,
      path: location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '<id>'),
      consent: state.consent, pro: state.pro,
      streamFlag: document.documentElement.getAttribute(STREAM_FLAG_ATTR),
      interceptor: document.documentElement.getAttribute(constants.INTERCEPTOR_ATTR) === '1',
      modules: Object.fromEntries([...registry.values()].map((e) => [e.def.id, { enabled: !!state.settings?.modules?.[e.def.id], active: e.active, error: e.error }])),
      selectorCounts: counts,
      composerChain: composer ? describeChain(composer, 8) : 'composer not found',
      firstMessageChain: msg ? describeChain(msg, 4) : 'no [data-message-author-role] elements',
      sidebarChatItem: firstChat ? describeTree(firstChat.closest('li') || firstChat.parentElement?.parentElement || firstChat, 4, 6) : 'no chat links found',
      sidebarHead: sidebar ? describeTree(sidebar, 2, 10) : 'sidebar not found',
      buttonsMentioningSidebar: $$('button, a').filter((b) => /sidebar/i.test(b.getAttribute('aria-label') || b.getAttribute('data-testid') || '')).map((b) => `${dom.describeEl(b)} visible=${dom.isVisible(b)}`),
      menuButtonsInSidebar: sidebar ? $$('button[aria-haspopup], [data-testid*="option" i]', sidebar).slice(0, 5).map(dom.describeEl) : [],
    };
    return report;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === MSG.DIAG) {
      try { sendResponse({ result: diagnostics() }); } catch (e) { sendResponse({ error: String(e && e.message || e) }); }
      return;
    }
    if (!msg || msg.type !== MSG.COMMAND) return;
    for (const entry of registry.values()) {
      if (!entry.active) continue;
      try { entry.mod.onCommand?.(msg.command); } catch (e) { warn('onCommand failed', entry.def.id, e); }
    }
    sendResponse?.({ ok: true });
  });

  dom.onNavigate((href) => {
    for (const entry of registry.values()) {
      if (!entry.active) continue;
      try { entry.mod.onNavigate?.(href); } catch (e) { warn('onNavigate failed', entry.def.id, e); }
    }
  });

  await sync();
  log('bootstrap complete');
})();

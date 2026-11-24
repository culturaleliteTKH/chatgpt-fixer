import { MODULES, MSG, PRO_PRICE, FREE_VAULT_LIMIT, CONSENT_VERSION } from '../shared/constants.js';
import * as storage from '../shared/storage.js';
import { setConsent, resetConsent, hasValidConsent } from '../shared/consent.js';
import { VaultClient, entryToMarkdown } from '../content/isolated/db/stream-vault.js';

const $ = (s) => document.querySelector(s);
const vault = new VaultClient();
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r); }));

let state = { settings: null, consent: null, license: { pro: false }, vaultCount: 0 };
let entries = [];

async function loadState() {
  const r = await send({ type: MSG.GET_STATE });
  if (r?.result) state = r.result;
  else state.settings = await storage.getSettings();
}

// ---------- tabs ----------
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) { t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', String(t === tab)); }
    for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`);
    if (tab.dataset.tab === 'vault') renderVault();
    try { localStorage.setItem('cgf-tab', tab.dataset.tab); } catch {}
  });
}
try { const t = localStorage.getItem('cgf-tab'); if (t) document.querySelector(`.tab[data-tab="${t}"]`)?.click(); } catch {}

// ---------- fixes ----------
function renderModules() {
  const list = $('#moduleList');
  list.textContent = '';
  const consentOk = hasValidConsent(state.consent);
  for (const def of MODULES) {
    const li = document.createElement('li');
    li.className = 'module';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = def.name;
    const sw = document.createElement('input'); sw.type = 'checkbox'; sw.className = 'switch'; sw.checked = !!state.settings.modules[def.id];
    sw.setAttribute('aria-label', `Enable ${def.name}`);
    sw.addEventListener('change', async () => { await storage.saveSettings({ modules: { [def.id]: sw.checked } }); });
    const desc = document.createElement('span'); desc.className = 'desc'; desc.textContent = def.desc;
    li.append(name, sw, desc);
    if (def.needsConsent && !consentOk) {
      const locked = document.createElement('span'); locked.className = 'locked desc'; locked.textContent = 'Waiting for local-processing consent';
      li.append(locked);
    }
    list.append(li);
  }
  $('#consentBanner').classList.toggle('hidden', consentOk);
  $('#proBadge').textContent = state.license.pro ? 'Pro' : 'Free';
  $('#proBadge').className = `pill ${state.license.pro ? 'pill-pro' : 'pill-free'}`;
  $('#vaultCount').textContent = state.vaultCount ? `(${state.vaultCount})` : '';
}
$('#consentAllow').addEventListener('click', async () => { await setConsent(true); await refresh(); });
$('#shortcutsLink').addEventListener('click', (e) => {
  e.preventDefault();
  const url = navigator.userAgent.includes('Firefox') ? 'about:addons' : 'chrome://extensions/shortcuts';
  chrome.tabs.create({ url });
});

// ---------- vault ----------
function fmt(ts) { try { return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }); } catch { return ''; } }

async function renderVault() {
  const list = $('#vaultList');
  try { entries = (await vault.list({ limit: state.license.pro ? 500 : FREE_VAULT_LIMIT })) || []; } catch { entries = []; }
  const q = $('#vaultSearch').value.trim().toLowerCase();
  const shown = q && state.license.pro ? entries.filter((e) => (e.text || '').toLowerCase().includes(q) || (e.prompt || '').toLowerCase().includes(q)) : entries;
  list.textContent = '';
  if (!shown.length) {
    const li = document.createElement('li'); li.className = 'hint'; li.textContent = 'No captured responses yet. They appear here as ChatGPT replies stream in.'; list.append(li);
  }
  for (const e of shown) {
    const li = document.createElement('li'); li.className = 'entry';
    const top = document.createElement('div'); top.className = 'top';
    const badge = document.createElement('span'); badge.className = `badge badge-${e.status}`; badge.textContent = e.status;
    const title = document.createElement('span'); title.className = 'title'; title.textContent = (e.prompt || e.text || '(empty)').slice(0, 90);
    const time = document.createElement('span'); time.className = 'time'; time.textContent = fmt(e.updatedAt);
    top.append(badge, title, time);
    const preview = document.createElement('div'); preview.className = 'preview'; preview.textContent = (e.text || '').slice(0, 300);
    const actions = document.createElement('div'); actions.className = 'actions';
    const mk = (label, cls, fn) => { const b = document.createElement('button'); b.className = `btn btn-small ${cls || ''}`; b.textContent = label; b.addEventListener('click', fn); return b; };
    actions.append(
      mk('Copy', 'btn-primary', async () => { await navigator.clipboard.writeText(e.text || ''); flashMsg('#vaultHint', 'Copied'); }),
      mk('Open chat', '', () => { if (e.conversationId) chrome.tabs.create({ url: `https://chatgpt.com/c/${e.conversationId}` }); }),
      mk('.md', '', () => {
        if (!state.license.pro) return flashMsg('#vaultHint', `Export is Pro (${PRO_PRICE}).`);
        downloadText(`chatgpt-recovered-${e.id}.md`, entryToMarkdown(e), 'text/markdown');
      }),
      mk('Delete', 'btn-danger', async () => { await vault.delete(e.id); renderVault(); }),
    );
    if (Array.isArray(e.raw) && e.raw.length) actions.append(mk('Raw', '', () => downloadText(`chatgpt-fixer-raw-${e.id}.txt`, e.raw.join('\n'), 'text/plain')));
    li.append(top, preview, actions);
    list.append(li);
  }
  $('#vaultSearch').disabled = !state.license.pro;
  $('#vaultHint').textContent = state.license.pro ? `${entries.length} captured response${entries.length === 1 ? '' : 's'}.` : `Free keeps the newest ${FREE_VAULT_LIMIT}. Pro keeps everything, adds search and export.`;
}
$('#vaultSearch').addEventListener('input', renderVault);
$('#vaultClear').addEventListener('click', async () => { if (confirm('Delete all captured responses?')) { await vault.clear(); renderVault(); } });
$('#vaultExport').addEventListener('click', async () => {
  if (!state.license.pro) return flashMsg('#vaultHint', `Export is Pro (${PRO_PRICE}).`);
  try { const data = await vault.exportAll(); downloadText(`chatgpt-fixer-vault-${Date.now()}.json`, JSON.stringify(data, null, 2), 'application/json'); }
  catch (e) { flashMsg('#vaultHint', String(e.message || e)); }
});

function downloadText(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 500);
}
function flashMsg(sel, text) { const el = $(sel); const old = el.textContent; el.textContent = text; setTimeout(() => { if (el.textContent === text) el.textContent = old; }, 2500); }

// ---------- settings ----------
function renderSettings() {
  const s = state.settings;
  $('#contextWindow').value = String(s.contextWindow);
  if (!$('#contextWindow').value) { const o = document.createElement('option'); o.value = String(s.contextWindow); o.textContent = `${s.contextWindow} (custom)`; $('#contextWindow').append(o); $('#contextWindow').value = String(s.contextWindow); }
  $('#showMeter').checked = !!s.showMeter;
  $('#inPageShortcuts').checked = !!s.shortcuts.inPage;
  $('#handoffDepth').value = s.handoffDepth;
  $('#handoffTemplate').value = s.handoffTemplate || '';
  $('#vaultKeepRaw').checked = !!s.vaultKeepRaw;
  $('#debug').checked = !!s.debug;
  for (const id of ['handoffDepth', 'handoffTemplate', 'vaultKeepRaw']) $(`#${id}`).disabled = !state.license.pro;
  const c = state.consent;
  $('#consentStatus').textContent = !c ? 'Consent: not asked yet' : c.version !== CONSENT_VERSION ? 'Consent: outdated, will re-ask' : c.accepted ? `Consent: granted ${fmt(c.at)}` : `Consent: declined ${fmt(c.at)}`;
}
$('#contextWindow').addEventListener('change', (e) => storage.saveSettings({ contextWindow: Number(e.target.value) }));
$('#showMeter').addEventListener('change', (e) => storage.saveSettings({ showMeter: e.target.checked }));
$('#inPageShortcuts').addEventListener('change', (e) => storage.saveSettings({ shortcuts: { inPage: e.target.checked } }));
$('#handoffDepth').addEventListener('change', (e) => storage.saveSettings({ handoffDepth: Math.max(1, Math.min(30, Number(e.target.value) || 3)) }));
$('#handoffTemplate').addEventListener('change', (e) => storage.saveSettings({ handoffTemplate: e.target.value }));
$('#vaultKeepRaw').addEventListener('change', (e) => storage.saveSettings({ vaultKeepRaw: e.target.checked }));
$('#debug').addEventListener('change', (e) => storage.saveSettings({ debug: e.target.checked }));
$('#consentReset').addEventListener('click', async () => { await resetConsent(); await refresh(); });

$('#diagRun').addEventListener('click', async () => {
  const out = $('#diagOut');
  out.value = 'Running…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
    const r = await new Promise((resolve) => chrome.tabs.sendMessage(tab.id, { type: MSG.DIAG }, (res) => { const err = chrome.runtime.lastError; resolve(err ? { error: err.message } : res); }));
    if (!r || r.error) throw new Error(r?.error || 'No response. Is this a chatgpt.com tab with the extension loaded?');
    out.value = JSON.stringify(r.result, null, 2);
    $('#diagCopy').disabled = false;
  } catch (e) {
    out.value = String(e.message || e);
  }
});
$('#diagCopy').addEventListener('click', async () => { await navigator.clipboard.writeText($('#diagOut').value); flashMsg('#consentStatus', 'Diagnostics copied'); });

// ---------- pro ----------
function renderPro() {
  $('#proPrice').textContent = `One-time ${PRO_PRICE}.`;
  $('#proFree').classList.toggle('hidden', !!state.license.pro);
  $('#proActive').classList.toggle('hidden', !state.license.pro);
  $('#licenseKeyShown').textContent = state.license.key || '';
}
$('#licenseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await send({ type: MSG.LICENSE_ACTIVATE, key: $('#licenseKey').value });
  const res = r?.result || { ok: false, reason: r?.error || 'Unknown error' };
  $('#licenseMsg').textContent = res.ok ? 'Pro activated. Thank you!' : res.reason;
  if (res.ok) await refresh();
});
$('#licenseRemove').addEventListener('click', async () => { await send({ type: MSG.LICENSE_CLEAR }); await refresh(); });

// ---------- boot ----------
async function refresh() {
  await loadState();
  renderModules(); renderSettings(); renderPro();
  if ($('#tab-vault').classList.contains('active')) renderVault();
}
storage.onChanged(() => refresh());
send({ type: MSG.BADGE_CLEAR });
refresh();

// Background service worker (MV3 module). Responsibilities:
//   - keyboard commands -> forward to the active chatgpt.com tab's content script
//   - own the vault (IndexedDB in the extension origin) and answer vault messages
//   - license activation, state snapshot for the popup, badge for unseen recoveries
// No network calls. No `tabs` permission needed: commands hand us the tab, and
// tabs.create/sendMessage work without it.
import { MSG, STORAGE_KEYS, FREE_VAULT_LIMIT, PRO_VAULT_LIMIT, DEFAULT_SETTINGS } from '../shared/constants.js';
import * as storage from '../shared/storage.js';
import * as license from '../shared/license.js';
import { getConsent } from '../shared/consent.js';
import { Vault } from '../content/isolated/db/stream-vault.js';

const vault = new Vault();

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const existing = await storage.get(STORAGE_KEYS.SETTINGS);
  if (!existing) await storage.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  if (reason === 'install') {
    try { await chrome.tabs.create({ url: 'https://chatgpt.com/' }); } catch {}
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    const target = tab?.id != null ? tab : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!target?.id) return;
    await chrome.tabs.sendMessage(target.id, { type: MSG.COMMAND, command });
  } catch (e) {
    // Not a chatgpt.com tab (no content script) — ignore.
  }
});

async function setBadge(n) {
  try {
    await chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
  } catch {}
}

async function getUnseen() {
  try { return (await chrome.storage.local.get(STORAGE_KEYS.UNSEEN))[STORAGE_KEYS.UNSEEN] || 0; } catch { return 0; }
}

async function bumpUnseen() {
  const n = (await getUnseen()) + 1;
  await chrome.storage.local.set({ [STORAGE_KEYS.UNSEEN]: n });
  setBadge(n);
}

async function pruneForTier() {
  const pro = await license.isPro();
  return vault.prune(pro ? PRO_VAULT_LIMIT : FREE_VAULT_LIMIT);
}

const handlers = {
  [MSG.GET_STATE]: async () => {
    const [settings, consent, lic, vaultCount] = await Promise.all([storage.getSettings(), getConsent(), license.getLicense(), vault.count()]);
    return { settings, consent, license: lic, vaultCount };
  },

  [MSG.VAULT_PUT]: async ({ entry }) => {
    const prev = await vault.get(entry.id);
    await vault.put(entry);
    const becameFailure = entry.status !== 'streaming' && entry.status !== 'complete' && (!prev || prev.status === 'streaming' || prev.status === 'complete');
    if (becameFailure && (entry.text || '').length > 0) await bumpUnseen();
    if (entry.status !== 'streaming') await pruneForTier();
    return entry.id;
  },
  [MSG.VAULT_GET]: ({ id }) => vault.get(id),
  [MSG.VAULT_LIST]: async ({ opts }) => {
    const pro = await license.isPro();
    const cap = pro ? PRO_VAULT_LIMIT : FREE_VAULT_LIMIT;
    return vault.list({ ...(opts || {}), limit: Math.min(opts?.limit ?? cap, cap) });
  },
  [MSG.VAULT_COUNT]: () => vault.count(),
  [MSG.VAULT_DELETE]: ({ id }) => vault.delete(id),
  [MSG.VAULT_CLEAR]: () => vault.clear(),
  [MSG.VAULT_EXPORT]: async () => {
    if (!(await license.isPro())) throw new Error('Export is a Pro feature');
    return vault.exportAll();
  },

  [MSG.LICENSE_ACTIVATE]: async ({ key }) => {
    const r = await license.activate(key);
    if (r.ok) await pruneForTier();
    return r;
  },
  [MSG.LICENSE_CLEAR]: async () => { await license.clear(); await pruneForTier(); return true; },

  [MSG.BADGE_CLEAR]: async () => { await chrome.storage.local.set({ [STORAGE_KEYS.UNSEEN]: 0 }); setBadge(0); return true; },
  [MSG.OPEN_URL]: async ({ url }) => {
    if (!/^https:\/\/chatgpt\.com\//.test(url)) throw new Error('refused');
    await chrome.tabs.create({ url });
    return true;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = msg && handlers[msg.type];
  if (!fn) return false;
  // Only accept messages from our own extension (content scripts, popup).
  if (sender.id && sender.id !== chrome.runtime.id) return false;
  Promise.resolve()
    .then(() => fn(msg, sender))
    .then((result) => sendResponse({ result }))
    .catch((e) => sendResponse({ error: String(e && e.message || e) }));
  return true; // async
});

// Restore badge on SW start.
getUnseen().then(setBadge);

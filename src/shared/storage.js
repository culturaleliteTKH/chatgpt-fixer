// Thin wrapper over chrome.storage. Prefers `sync` (settings follow the user), falls back to `local`.
import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants.js';

const api = globalThis.chrome ?? globalThis.browser;

function area() {
  return api?.storage?.sync ?? api?.storage?.local;
}

export async function get(key, fallback = undefined) {
  try {
    const out = await area().get(key);
    return out?.[key] === undefined ? fallback : out[key];
  } catch {
    return fallback;
  }
}

export async function set(obj) {
  try {
    await area().set(obj);
    return true;
  } catch (e) {
    // sync quota or unavailable: fall back to local so the write is not lost
    try { await api.storage.local.set(obj); return true; } catch { return false; }
  }
}

export async function remove(key) {
  try { await area().remove(key); } catch {}
}

/** Deep-merge saved settings over defaults so new keys appear for existing users. */
export async function getSettings() {
  const saved = (await get(STORAGE_KEYS.SETTINGS)) || {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    modules: { ...DEFAULT_SETTINGS.modules, ...(saved.modules || {}) },
    shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...(saved.shortcuts || {}) },
  };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    modules: { ...current.modules, ...(patch.modules || {}) },
    shortcuts: { ...current.shortcuts, ...(patch.shortcuts || {}) },
  };
  await set({ [STORAGE_KEYS.SETTINGS]: next });
  return next;
}

/** Subscribe to any change in either storage area. Returns an unsubscribe function. */
export function onChanged(cb) {
  const handler = (changes, areaName) => {
    try { cb(changes, areaName); } catch {}
  };
  api.storage.onChanged.addListener(handler);
  return () => api.storage.onChanged.removeListener(handler);
}

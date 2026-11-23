// Pro licensing (one-time unlock). Local-first: the key is validated offline by format + checksum.
//
// IMPORTANT: an offline checksum only stops casual guessing. For real sales, swap `verifyKey` for a
// call to your payments provider (ExtensionPay, Lemon Squeezy License API, Gumroad, Paddle…) and
// cache the result. The rest of the extension only calls `isPro()` / `getLicense()`.
import { STORAGE_KEYS } from './constants.js';
import * as storage from './storage.js';

const KEY_RE = /^CGF-([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity

export function normalizeKey(raw) {
  return String(raw || '').trim().toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9-]/g, '');
}

/** FNV-1a 32-bit, folded to a 4-char code over ALPHABET. */
function checksum(body) {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += ALPHABET[h % ALPHABET.length];
    h = Math.floor(h / ALPHABET.length);
  }
  return out;
}

export function isWellFormed(key) {
  return KEY_RE.test(normalizeKey(key));
}

/** Offline verification. Replace/augment with a remote check in production. */
export async function verifyKey(key) {
  const k = normalizeKey(key);
  const m = KEY_RE.exec(k);
  if (!m) return { ok: false, reason: 'Key format is CGF-XXXX-XXXX-XXXX-XXXX' };
  const body = `CGF-${m[1]}-${m[2]}-${m[3]}`;
  if (checksum(body) !== m[4]) return { ok: false, reason: 'That key is not valid' };
  return { ok: true };
}

/** Dev/test helper: mint a valid key from any seed string. */
export function generateKey(seed = String(Math.random())) {
  let h = 0x811c9dc5;
  const chunk = () => {
    let s = '';
    for (let i = 0; i < 4; i++) {
      h ^= seed.charCodeAt((h + i) % seed.length) || 7;
      h = Math.imul(h, 0x01000193) >>> 0;
      s += ALPHABET[h % ALPHABET.length];
    }
    return s;
  };
  const body = `CGF-${chunk()}-${chunk()}-${chunk()}`;
  return `${body}-${checksum(body)}`;
}

export async function getLicense() {
  return (await storage.get(STORAGE_KEYS.LICENSE)) || { pro: false, key: null, validatedAt: 0 };
}

export async function isPro() {
  const lic = await getLicense();
  return lic.pro === true;
}

export async function activate(rawKey) {
  const result = await verifyKey(rawKey);
  if (!result.ok) return result;
  const value = { pro: true, key: normalizeKey(rawKey), validatedAt: Date.now() };
  await storage.set({ [STORAGE_KEYS.LICENSE]: value });
  return { ok: true, license: value };
}

export async function clear() {
  await storage.set({ [STORAGE_KEYS.LICENSE]: { pro: false, key: null, validatedAt: 0 } });
}

// Local vault for captured responses.
//
// The database lives in the EXTENSION origin (opened by the service worker), not chatgpt.com's,
// so clearing site data does not wipe it and the popup can read it. Content scripts and the popup
// use `VaultClient`, which proxies calls over chrome.runtime messaging. `Vault` is the IndexedDB
// implementation used by the service worker. Falls back to memory if IndexedDB is unavailable
// (e.g. Firefox private windows).
import { MSG } from '../../../shared/constants.js';

const DB_NAME = 'cgf-vault';
const DB_VERSION = 1;
const STORE = 'responses';

/**
 * Entry shape:
 * {
 *   id, conversationId, messageId, model, url, prompt, text,
 *   status: 'streaming' | 'complete' | 'interrupted' | 'error' | 'vanished',
 *   startedAt, updatedAt, endedAt, eventCount, raw?: string[], note?: string
 * }
 */
export class Vault {
  constructor() {
    this._db = null;
    this._mem = new Map();
    this._useMem = typeof indexedDB === 'undefined';
  }

  async _open() {
    if (this._useMem) return null;
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('byUpdated', 'updatedAt');
          s.createIndex('byConversation', 'conversationId');
          s.createIndex('byStatus', 'status');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('vault blocked'));
    }).catch((e) => { console.warn('[cgf] IndexedDB unavailable, using memory', e); this._useMem = true; return null; });
    return this._db;
  }

  async _tx(mode, fn) {
    const db = await this._open();
    if (!db) return fn(null);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let out;
      try { out = fn(store); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
  }

  async put(entry) {
    if (!entry || !entry.id) throw new Error('entry.id required');
    entry.updatedAt = entry.updatedAt || Date.now();
    if (this._useMem) { this._mem.set(entry.id, entry); return entry.id; }
    await this._tx('readwrite', (s) => s.put(entry));
    return entry.id;
  }

  /** Shallow-merge a patch into an existing entry (creates it if missing). */
  async patch(id, patch) {
    const cur = (await this.get(id)) || { id, startedAt: Date.now() };
    const next = { ...cur, ...patch, id, updatedAt: Date.now() };
    await this.put(next);
    return next;
  }

  async get(id) {
    if (this._useMem) return this._mem.get(id) || null;
    const r = await this._tx('readonly', (s) => s.get(id));
    return r || null;
  }

  async list({ limit = 50, conversationId = null } = {}) {
    let all;
    if (this._useMem) all = Array.from(this._mem.values());
    else all = (await this._tx('readonly', (s) => s.getAll())) || [];
    if (conversationId) all = all.filter((e) => e.conversationId === conversationId);
    all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return all.slice(0, limit);
  }

  async count() {
    if (this._useMem) return this._mem.size;
    return (await this._tx('readonly', (s) => s.count())) || 0;
  }

  async delete(id) {
    if (this._useMem) return this._mem.delete(id);
    await this._tx('readwrite', (s) => s.delete(id));
    return true;
  }

  async clear() {
    if (this._useMem) { this._mem.clear(); return true; }
    await this._tx('readwrite', (s) => s.clear());
    return true;
  }

  /** Keep the newest `keep` finished entries (never prunes an in-flight stream). */
  async prune(keep) {
    const all = await this.list({ limit: 100000 });
    const finished = all.filter((e) => e.status !== 'streaming');
    const doomed = finished.slice(keep);
    for (const e of doomed) await this.delete(e.id);
    return doomed.length;
  }

  async exportAll() {
    const all = await this.list({ limit: 100000 });
    return { exportedAt: new Date().toISOString(), count: all.length, entries: all };
  }
}

/** Messaging proxy used from content scripts and the popup. */
export class VaultClient {
  constructor(send) {
    this._send = send || ((msg) => new Promise((resolve) => {
      try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r); }); } catch { resolve(undefined); }
    }));
  }
  async _call(type, payload = {}) {
    const r = await this._send({ type, ...payload });
    if (r && r.error) throw new Error(r.error);
    return r ? r.result : undefined;
  }
  put(entry) { return this._call(MSG.VAULT_PUT, { entry }); }
  get(id) { return this._call(MSG.VAULT_GET, { id }); }
  list(opts) { return this._call(MSG.VAULT_LIST, { opts }); }
  count() { return this._call(MSG.VAULT_COUNT); }
  delete(id) { return this._call(MSG.VAULT_DELETE, { id }); }
  clear() { return this._call(MSG.VAULT_CLEAR); }
  exportAll() { return this._call(MSG.VAULT_EXPORT); }
}

/** Format an entry as Markdown for copy/export. */
export function entryToMarkdown(e) {
  const when = new Date(e.startedAt || e.updatedAt || Date.now()).toISOString();
  const head = [
    `# Recovered ChatGPT response`,
    ``,
    `- Captured: ${when}`,
    `- Status: ${e.status}`,
    e.model ? `- Model: ${e.model}` : null,
    e.conversationId ? `- Conversation: https://chatgpt.com/c/${e.conversationId}` : null,
    ``,
  ].filter((x) => x !== null).join('\n');
  const prompt = e.prompt ? `## Prompt\n\n${e.prompt}\n\n` : '';
  return `${head}${prompt}## Response\n\n${e.text || '(no text captured)'}\n`;
}

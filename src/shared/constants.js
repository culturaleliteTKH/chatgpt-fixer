// Shared constants. Imported by the service worker, popup and (via dynamic import) the isolated content script.
// The MAIN-world interceptor cannot import modules, so a few values are duplicated there — keep them in sync.

export const EXT_NAME = 'ChatGPT Fixer';
export const PREFIX = 'cgf';

/** Window-level CustomEvents used to bridge MAIN <-> ISOLATED worlds. `detail` is always a JSON string. */
export const EVENTS = {
  STREAM: 'cgf:stream',            // MAIN -> ISOLATED: stream lifecycle + raw SSE data lines
  CONTROL: 'cgf:control',          // ISOLATED -> MAIN: { enabled: boolean }
  READY: 'cgf:interceptor-ready',  // MAIN -> ISOLATED: interceptor installed
};

/** `<html data-cgf-stream="on">` tells the MAIN-world interceptor that consent is given and Anti-Vanish is on. */
export const STREAM_FLAG_ATTR = 'data-cgf-stream';
/** Set by the MAIN-world interceptor once window.fetch is wrapped. */
export const INTERCEPTOR_ATTR = 'data-cgf-interceptor';

/** chrome.runtime message types. */
export const MSG = {
  GET_STATE: 'cgf/get-state',
  COMMAND: 'cgf/command',
  VAULT_PUT: 'cgf/vault/put',
  VAULT_GET: 'cgf/vault/get',
  VAULT_LIST: 'cgf/vault/list',
  VAULT_DELETE: 'cgf/vault/delete',
  VAULT_CLEAR: 'cgf/vault/clear',
  VAULT_COUNT: 'cgf/vault/count',
  VAULT_EXPORT: 'cgf/vault/export',
  LICENSE_ACTIVATE: 'cgf/license/activate',
  LICENSE_CLEAR: 'cgf/license/clear',
  BADGE_CLEAR: 'cgf/badge/clear',
  OPEN_URL: 'cgf/open-url',
  DIAG: 'cgf/diag',
};

export const COMMANDS = {
  TOGGLE_SIDEBAR: 'toggle-sidebar',
  BRANCH_CHAT: 'branch-chat',
};

export const STORAGE_KEYS = {
  SETTINGS: 'settings',
  CONSENT: 'consent',
  LICENSE: 'license',
  UNSEEN: 'unseenRecoveries',
};

export const CONSENT_VERSION = 1;

/** Module registry. `file` is relative to src/content/isolated/modules/. */
export const MODULES = [
  {
    id: 'navTabs',
    file: 'nav-tabs.js',
    name: 'Classic navigation',
    desc: 'Middle-click / Ctrl-click opens chats in a new tab. Predictable sidebar toggle (Alt+S).',
    tier: 'free',
    needsConsent: false,
  },
  {
    id: 'quoteJump',
    file: 'quote-jump.js',
    name: 'Quote jump',
    desc: 'Click a quoted passage to jump to the message it came from.',
    tier: 'free',
    needsConsent: false,
  },
  {
    id: 'projectActions',
    file: 'project-actions.js',
    name: 'Quick project & search actions',
    desc: 'Hover "Move to project" on chats; open search results in a new tab. Bulk move on Pro.',
    tier: 'free',
    needsConsent: false,
  },
  {
    id: 'antiVanish',
    file: 'anti-vanish.js',
    name: 'Anti-Vanish stream guard',
    desc: 'Captures responses while they stream so cut-offs and vanished replies can be recovered.',
    tier: 'free',
    needsConsent: true,
  },
  {
    id: 'contextHandoff',
    file: 'context-handoff.js',
    name: 'Context meter & branch handoff',
    desc: 'Local token estimate near the composer. Branch to a fresh chat with a handoff prompt (Alt+B).',
    tier: 'free',
    needsConsent: true,
  },
];

export const DEFAULT_SETTINGS = {
  modules: Object.fromEntries(MODULES.map((m) => [m.id, true])),
  shortcuts: {
    toggleSidebar: 'Alt+S',
    branchChat: 'Alt+B',
    inPage: true, // also listen for shortcuts inside the page (works even if chrome://extensions/shortcuts is unset)
  },
  contextWindow: 128000,  // tokens; adjust per model in the popup
  handoffDepth: 3,        // messages included in a handoff (free: fixed 3; Pro: up to HANDOFF_MAX_DEPTH)
  handoffTemplate: '',    // Pro: custom template; empty = default
  vaultKeepRaw: false,    // Pro: keep raw SSE events alongside assembled text
  showMeter: true,
  debug: false,
};

export const FREE_VAULT_LIMIT = 5;
export const PRO_VAULT_LIMIT = 2000;
export const FREE_HANDOFF_DEPTH = 3;
export const HANDOFF_MAX_DEPTH = 30;
export const PRO_PRICE = '$7.99';

/** A streaming response with no events for this long is treated as stuck. */
export const STALE_STREAM_MS = 30000;
/** After a stream finishes, wait this long before checking the DOM for the message. */
export const VANISH_CHECK_DELAY_MS = 4000;

/** Pathname regex for the streaming completion endpoint (POST). Keep in sync with stream-interceptor.js. */
export const STREAM_ENDPOINT_RE = /\/backend-(?:api|alt)\/(?:f\/)?conversation$/;

export const DEFAULT_HANDOFF_TEMPLATE = `I'm continuing a conversation that was getting too long for its context window. Here is the handoff.

Title: {title}
Source: {url}

Recent exchange (oldest first):
{messages}

Please pick up exactly where this left off. Keep the same goals, constraints and tone. My next message continues the thread.`;

export const PLACEHOLDERS = ['{title}', '{url}', '{messages}', '{date}', '{count}'];

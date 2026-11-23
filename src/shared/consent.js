// First-run disclosure + consent. Required before any module reads conversation content
// (Anti-Vanish stream capture, context/token estimation). Everything stays in the browser.
import { CONSENT_VERSION, STORAGE_KEYS, EXT_NAME } from './constants.js';
import * as storage from './storage.js';

export const CONSENT_COPY = {
  title: `${EXT_NAME} needs your OK to read this page`,
  intro: 'Two features read the content of your ChatGPT conversations. Everything is processed locally in your browser and nothing is sent to any server, including ours.',
  points: [
    {
      heading: 'Anti-Vanish stream guard',
      body: 'Watches responses as they stream in and keeps a local copy (browser IndexedDB) so a cut-off or vanished reply can be recovered. Only the response text and your prompt are stored.',
    },
    {
      heading: 'Context meter & branch handoff',
      body: 'Reads the visible messages to estimate how full the context window is and to build a handoff prompt when you branch. Nothing is stored unless you branch, and even then it only goes to your clipboard.',
    },
  ],
  footer: 'You can change your mind any time from the extension popup. Declining keeps the navigation fixes working and turns off these two features.',
  accept: 'Allow local processing',
  decline: 'Not now',
};

export async function getConsent() {
  return (await storage.get(STORAGE_KEYS.CONSENT)) || null;
}

export function hasValidConsent(consent) {
  return !!consent && consent.accepted === true && consent.version === CONSENT_VERSION;
}

/** `decided` means the user has seen the prompt (accepted or declined) for the current version. */
export function hasDecided(consent) {
  return !!consent && consent.version === CONSENT_VERSION && typeof consent.accepted === 'boolean';
}

export async function setConsent(accepted) {
  const value = { accepted: !!accepted, version: CONSENT_VERSION, at: Date.now() };
  await storage.set({ [STORAGE_KEYS.CONSENT]: value });
  return value;
}

export async function resetConsent() {
  await storage.remove(STORAGE_KEYS.CONSENT);
}

/**
 * Build the in-page consent modal. Pure DOM, no innerHTML with user data.
 * Styles live in fixer.css under .cgf-consent-*.
 */
export function renderConsentModal(doc, { onAccept, onDecline }) {
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const backdrop = el('div', 'cgf-root cgf-consent-backdrop');
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', 'cgf-consent-title');

  const card = el('div', 'cgf-consent-card');
  const title = el('h2', 'cgf-consent-title', CONSENT_COPY.title);
  title.id = 'cgf-consent-title';
  card.append(title, el('p', 'cgf-consent-intro', CONSENT_COPY.intro));

  const list = el('ul', 'cgf-consent-list');
  for (const p of CONSENT_COPY.points) {
    const li = el('li');
    li.append(el('strong', null, p.heading), el('span', null, ' ' + p.body));
    list.append(li);
  }
  card.append(list, el('p', 'cgf-consent-footer', CONSENT_COPY.footer));

  const actions = el('div', 'cgf-consent-actions');
  const decline = el('button', 'cgf-btn cgf-btn-ghost', CONSENT_COPY.decline);
  const accept = el('button', 'cgf-btn cgf-btn-primary', CONSENT_COPY.accept);
  decline.type = accept.type = 'button';
  decline.addEventListener('click', () => { backdrop.remove(); onDecline?.(); });
  accept.addEventListener('click', () => { backdrop.remove(); onAccept?.(); });
  actions.append(decline, accept);
  card.append(actions);
  backdrop.append(card);
  queueMicrotask(() => accept.focus());
  return backdrop;
}

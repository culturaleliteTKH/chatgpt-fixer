# ChatGPT Fixer — Classic UX & Session Guard

A lightweight Manifest V3 extension (Chrome + Firefox 128+) that patches recent ChatGPT web UI
regressions, stops responses from vanishing, and adds context-window handoff tools.
Local-first: nothing leaves the browser. Permissions: `storage` + `https://chatgpt.com/*` only.

## Load it (dev)

Chrome / Edge / Brave:
1. `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick this folder.
2. Open https://chatgpt.com. Accept the first-run local-processing prompt.

Firefox (128+): `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* →
pick `dist/firefox/manifest.json` after running `npm run build` (Firefox needs the event-page manifest).

Checks and packaging:

```bash
npm run check
```

```bash
npm run build
```

## Modules

| Module | File | Free | Pro |
| --- | --- | --- | --- |
| Classic navigation | `nav-tabs.js` | Middle/Ctrl-click opens chats in a new tab; sidebar toggle `Alt+S` | Custom shortcut strings |
| Quote jump | `quote-jump.js` | Click a quote to jump to its source message | — |
| Project & search actions | `project-actions.js` | Hover "Move to project"; open search results in new tab | Bulk move (`Alt+Shift+M`), `Alt+1…9` quick-jump |
| Anti-Vanish | `stream-interceptor.js` + `anti-vanish.js` + `stream-vault.js` | Keeps newest 5 captured responses; recover toast | Full history, search, raw events, `.md`/JSON export |
| Context meter & handoff | `context-handoff.js` | Token meter above composer; `Alt+B` copies a 3-message handoff | 1-click branch with pre-filled new chat, custom template, depth ≤ 30 |

Every module is `{ id, init(ctx), destroy(), onCommand?, onNavigate?, onSettings? }` and is loaded,
started and stopped inside `try/catch` by `src/content/isolated/bootstrap.js`. Toggling a module in the
popup takes effect live.

## Architecture

```
MAIN world (document_start)              ISOLATED world (document_idle)              Service worker
stream-interceptor.js                     bootstrap.js  ──dynamic import──▶ modules/*   service-worker.js
  wraps window.fetch                        dom-observer.js (selectors, observer)        owns IndexedDB vault
  tees /backend-api/conversation            ui.js (toast, panel)                         commands → tab
  ──CustomEvent 'cgf:stream'──▶             anti-vanish.js assembles SSE deltas  ──msg──▶ vault.put / prune
  passive until <html data-cgf-stream=on>   context-handoff.js, nav-tabs.js, …          popup ◀── GET_STATE
```

* **Consent gate.** The interceptor is installed at `document_start` but does nothing until the
  isolated side sets `<html data-cgf-stream="on">`, which only happens after the user accepts the
  first-run disclosure *and* Anti-Vanish is enabled. Declining keeps the navigation fixes working.
* **Vault location.** IndexedDB is opened by the service worker (extension origin), so the popup can
  read it and clearing chatgpt.com site data does not wipe it. Content scripts talk to it through
  `VaultClient` (runtime messaging).
* **Selectors.** All DOM knowledge lives in `dom-observer.js` (`SEL`). Prefer `data-testid`, ARIA and
  structure; never Tailwind classes.
* **Pro gating.** `license.js` validates `CGF-XXXX-XXXX-XXXX-XXXX` keys offline (format + FNV-1a
  checksum). This stops casual guessing only — wire `verifyKey()` to ExtensionPay / Lemon Squeezy /
  Paddle before selling. `generateKey()` mints test keys:
  `node -e "import('./src/shared/license.js').then(m=>console.log(m.generateKey('test')))"`.

## Chrome Web Store notes

* **Single purpose:** "Restores classic ChatGPT navigation and prevents response loss on chatgpt.com."
* **Permission justifications:** `storage` — module toggles, consent and license; host
  `https://chatgpt.com/*` — content scripts that patch the UI and capture the page's own streams.
  No `tabs`, `webRequest`, `scripting`, or remote code.
* **Privacy:** conversation text is processed and stored locally (IndexedDB / `chrome.storage`) and
  never transmitted. Say so in the listing's privacy section and in a hosted privacy policy.
* **Naming:** "ChatGPT" is an OpenAI trademark. Stores sometimes reject names that *start* with a
  third-party mark. If reviewers push back, rename to something like "Fixer for ChatGPT" and keep the
  description honest about being unaffiliated.

## Test checklist (manual, on chatgpt.com)

- [ ] First run shows the consent modal; *Not now* leaves nav fixes active and meter hidden.
- [ ] Middle-click a sidebar chat → opens in a new tab, current tab unchanged. Same for *New chat*.
- [ ] `Alt+S` toggles the sidebar; also via `chrome://extensions/shortcuts` command.
- [ ] Ask a question; the vault (popup → Vault) shows an entry that goes `streaming → complete`.
- [ ] Press *Stop* mid-answer → toast "Generation was cut off", entry `interrupted`, *Recover* opens the panel.
- [ ] Kill the network mid-answer → entry `interrupted`, badge count increments.
- [ ] Reload mid-stream → previous entry becomes `interrupted` with note "Page reloaded mid-stream".
- [ ] Meter appears above the composer in a thread; percentage grows with the thread.
- [ ] `Alt+B` (free) copies handoff + opens new chat; with a Pro key, new chat opens pre-filled via `?q=`.
- [ ] Toggling any module in the popup adds/removes its UI without reload.
- [ ] Disable Anti-Vanish → `<html data-cgf-stream>` becomes `off`; no new vault entries.

## Known limitations

* If ChatGPT switches a session to WebSocket streaming, the fetch tee sees nothing. Add a
  `WebSocket` wrapper in `stream-interceptor.js` if that becomes common.
* "Move to project" drives ChatGPT's own menu by label text; a rename of the menu item needs a regex
  update in `project-actions.js`.
* Token count is a character heuristic (≈3.8 chars/token), not a tokenizer. Good enough for a meter.
* `?q=` pre-fill depends on ChatGPT honoring the query parameter and has a practical URL-length limit;
  long handoffs fall back to clipboard.

## Automated tests

```bash
npm test
```

`tests/unit.mjs` covers the SSE assembler (delta-encoded and legacy frames) and license checksum.

```bash
npm run e2e
```

`tests/e2e.mjs` launches Chromium with the extension loaded, mocks `chatgpt.com` (page + SSE endpoint)
via Playwright routes, and walks consent → stream capture → vanish detection → recovery panel →
middle-click → `Alt+S` → popup → Pro activation → live module toggle. Requires `playwright` resolvable
by Node and a Chromium build (`npx playwright install chromium` if you have none).

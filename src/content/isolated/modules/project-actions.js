// Quick project & search actions:
//   Free: hover "Move to project" button on sidebar chats (drives ChatGPT's own menu), and an
//         "open in new tab" affordance on search-dialog results.
//   Pro:  bulk move (pick several chats, run the move flow for each) and Alt+1…9 to open the
//         n-th search result in a new tab.

let ctx = null;
let unsubMutation = null;
let handlers = [];
let picking = false;
const picked = new Set();

function on(target, type, fn, opts) { target.addEventListener(type, fn, opts); handlers.push(() => target.removeEventListener(type, fn, opts)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sidebarChatItems() {
  const { SEL, $$ } = ctx.dom;
  const seen = new Set();
  const out = [];
  for (const nav of $$(SEL.sidebar)) {
    for (const a of $$(SEL.chatLink, nav)) {
      if (seen.has(a) || a.closest(SEL.dialog)) continue;
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

function searchResults() {
  const { SEL, $$ } = ctx.dom;
  const dlg = document.querySelector(SEL.dialog);
  if (!dlg) return [];
  return $$(SEL.chatLink, dlg);
}

/** Open the chat's own "…" menu and click the move-to-project item. Returns true when the item was clicked. */
async function moveToProject(item) {
  const { SEL, waitForVisible } = ctx.dom;
  // Hover first: the options button is often rendered only for the hovered row.
  for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) {
    item.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseenter' && type !== 'pointerenter', cancelable: true }));
  }
  await sleep(120);
  let opt = null;
  let scope = item;
  for (let i = 0; i < 5 && scope && !opt; i++) {
    opt = Array.from(scope.querySelectorAll(SEL.chatItemOptions)).find((b) => !b.closest(SEL.dialog) && ctx.dom.isVisible(b)) || null;
    scope = scope.parentElement;
  }
  if (opt) opt.click();
  else item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: item.getBoundingClientRect().left + 20, clientY: item.getBoundingClientRect().top + 10 }));
  let menu;
  try { menu = await waitForVisible(SEL.menu, { timeout: 2500 }); }
  catch { ctx.ui.toast(opt ? 'The options menu did not open.' : 'Could not find the chat options button (run Diagnostics in the popup).', { kind: 'warn' }); return false; }
  await sleep(150);
  const labelOf = (mi) => `${mi.getAttribute('aria-label') || ''} ${mi.textContent || ''}`.replace(/\s+/g, ' ').trim();
  let items = Array.from(menu.querySelectorAll(SEL.menuItem)).filter(ctx.dom.isVisible);
  if (!items.length) items = Array.from(document.querySelectorAll(SEL.menuItem)).filter((mi) => ctx.dom.isVisible(mi) && !mi.closest(SEL.sidebar));
  if (!items.length) items = Array.from(menu.querySelectorAll('button, a, [tabindex]')).filter(ctx.dom.isVisible);
  const target = items.find((mi) => /move to (another )?project|add to project|move to|projects?/i.test(labelOf(mi)));
  if (!target) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const seen = items.map((mi) => labelOf(mi).slice(0, 24)).filter(Boolean).slice(0, 8).join(' · ') || 'no items';
    ctx.ui.toast(`No "Move to project" item in this menu. Found: ${seen}`, { kind: 'warn', timeout: 12000 });
    ctx.log('menu', ctx.dom.describeTree(menu, 3, 12).join('\n'));
    return false;
  }
  target.click();
  // Submenus: a project list may open as a nested menu; let the user pick there.
  return true;
}

function decorateSidebar() {
  for (const a of sidebarChatItems()) {
    if (a.querySelector('.cgf-move')) continue;
    const btn = ctx.ui.el('button', { class: 'cgf-move cgf-hover-action', type: 'button', title: 'Move to project', 'aria-label': 'Move to project' }, ['⇢']);
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); moveToProject(a); });
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    a.classList.add('cgf-has-action');
    a.append(btn);
    if (picking) addPicker(a);
  }
}

function decorateSearch() {
  const results = searchResults();
  results.forEach((a, i) => {
    if (a.querySelector('.cgf-jump')) return;
    const href = new URL(a.getAttribute('href'), location.origin).href;
    const label = i < 9 ? `Open in new tab (Alt+${i + 1})` : 'Open in new tab';
    const btn = ctx.ui.el('button', { class: 'cgf-jump cgf-hover-action', type: 'button', title: label, 'aria-label': label }, ['↗']);
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); window.open(href, '_blank', 'noopener'); });
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    a.classList.add('cgf-has-action');
    a.append(btn);
  });
}

function addPicker(a) {
  if (a.querySelector('.cgf-pick')) return;
  const cb = ctx.ui.el('input', { class: 'cgf-pick', type: 'checkbox', title: 'Select for bulk move' });
  cb.checked = picked.has(a.getAttribute('href'));
  cb.addEventListener('click', (e) => { e.stopPropagation(); });
  cb.addEventListener('change', () => { const h = a.getAttribute('href'); cb.checked ? picked.add(h) : picked.delete(h); updateBar(); });
  a.prepend(cb);
}

let bar = null;
function updateBar() {
  if (!picking) { bar?.remove(); bar = null; return; }
  if (!bar) {
    bar = ctx.ui.el('div', { class: 'cgf-root cgf-bulkbar' });
    document.documentElement.append(bar);
  }
  bar.textContent = '';
  bar.append(
    ctx.ui.el('span', { text: `${picked.size} selected` }),
    ctx.ui.el('button', { class: 'cgf-btn cgf-btn-primary cgf-btn-small', type: 'button', text: 'Move selected…', onClick: runBulk }),
    ctx.ui.el('button', { class: 'cgf-btn cgf-btn-ghost cgf-btn-small', type: 'button', text: 'Cancel', onClick: () => setPicking(false) }),
  );
}

function setPicking(onOff) {
  picking = onOff;
  if (!picking) { picked.clear(); for (const cb of ctx.dom.$$('.cgf-pick')) cb.remove(); }
  else for (const a of sidebarChatItems()) addPicker(a);
  updateBar();
}

async function runBulk() {
  const hrefs = Array.from(picked);
  if (!hrefs.length) return;
  for (const [i, h] of hrefs.entries()) {
    const a = sidebarChatItems().find((x) => x.getAttribute('href') === h);
    if (!a) continue;
    ctx.ui.toast(`Moving ${i + 1} of ${hrefs.length} — pick the project in ChatGPT's dialog.`, { timeout: 4000 });
    const ok = await moveToProject(a);
    if (!ok) break;
    // Wait until the dialog/menu closes before proceeding to the next one.
    for (let t = 0; t < 600; t++) { await sleep(100); if (!document.querySelector(ctx.dom.SEL.menu) && !document.querySelector(ctx.dom.SEL.dialog)) break; }
    await sleep(300);
  }
  setPicking(false);
}

function onKey(e) {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 9) {
    const results = searchResults();
    if (!results.length) return;
    if (!ctx.gate('Quick-jump (Alt+1…9)')) return;
    const a = results[n - 1];
    if (!a) return;
    e.preventDefault();
    window.open(new URL(a.getAttribute('href'), location.origin).href, '_blank', 'noopener');
  }
  if (e.key.toLowerCase() === 'm' && e.shiftKey) { // Alt+Shift+M: bulk move pick mode
    if (!ctx.gate('Bulk move')) return;
    e.preventDefault();
    setPicking(!picking);
  }
}

function refresh() { try { decorateSidebar(); decorateSearch(); } catch (e) { ctx.warn('project-actions refresh', e); } }

export default {
  id: 'projectActions',
  init(c) {
    ctx = c;
    unsubMutation = ctx.dom.onMutation(refresh);
    on(document, 'keydown', onKey, { capture: true });
    refresh();
  },
  destroy() {
    unsubMutation?.(); handlers.forEach((f) => f()); handlers = [];
    setPicking(false);
    for (const n of ctx.dom.$$('.cgf-move, .cgf-jump, .cgf-pick')) n.remove();
    for (const n of ctx.dom.$$('.cgf-has-action')) n.classList.remove('cgf-has-action');
  },
};

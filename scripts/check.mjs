// Sanity checks: manifests parse, every referenced file exists, all JS parses, CSS classes are cgf-scoped.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const fail = (m) => { failures++; console.error('✗', m); };
const ok = (m) => console.log('✓', m);

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (!['node_modules', 'dist', '.git'].includes(n)) walk(p, out); }
    else out.push(p);
  }
  return out;
}

for (const mf of ['manifest.json', 'manifest.firefox.json']) {
  let m;
  try { m = JSON.parse(readFileSync(join(root, mf), 'utf8')); ok(`${mf} parses`); } catch (e) { fail(`${mf}: ${e.message}`); continue; }
  const refs = new Set();
  Object.values(m.icons || {}).forEach((p) => refs.add(p));
  Object.values(m.action?.default_icon || {}).forEach((p) => refs.add(p));
  if (m.action?.default_popup) refs.add(m.action.default_popup);
  if (m.background?.service_worker) refs.add(m.background.service_worker);
  (m.background?.scripts || []).forEach((p) => refs.add(p));
  for (const cs of m.content_scripts || []) { (cs.js || []).forEach((p) => refs.add(p)); (cs.css || []).forEach((p) => refs.add(p)); }
  for (const r of refs) existsSync(join(root, r)) ? ok(`${mf} → ${r}`) : fail(`${mf} references missing file ${r}`);
  if (m.manifest_version !== 3) fail(`${mf}: manifest_version must be 3`);
  const perms = m.permissions || [];
  const risky = perms.filter((p) => ['tabs', 'webRequest', 'webRequestBlocking', 'scripting', '<all_urls>'].includes(p));
  risky.length ? fail(`${mf}: unexpected permissions ${risky.join(', ')}`) : ok(`${mf}: permissions minimal (${perms.join(', ')})`);
  const hosts = m.host_permissions || [];
  hosts.every((h) => h === 'https://chatgpt.com/*') ? ok(`${mf}: host_permissions scoped to chatgpt.com`) : fail(`${mf}: host_permissions too broad: ${hosts}`);
}

// Modules referenced from constants exist
const constants = readFileSync(join(root, 'src/shared/constants.js'), 'utf8');
for (const [, file] of constants.matchAll(/file:\s*'([^']+)'/g)) {
  const p = join(root, 'src/content/isolated/modules', file);
  existsSync(p) ? ok(`module ${file}`) : fail(`module file missing: ${file}`);
}

// Dynamic imports in content scripts resolve
for (const f of walk(join(root, 'src/content'))) {
  const src = readFileSync(f, 'utf8');
  for (const [, p] of src.matchAll(/getURL\('([^']+\.js)'\)/g)) {
    existsSync(join(root, p)) ? ok(`${f.replace(root + '/', '')} → ${p}`) : fail(`${f} imports missing ${p}`);
  }
}

// JS syntax
for (const f of walk(root).filter((p) => /\.(m?js)$/.test(p))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); ok(`syntax ${f.replace(root + '/', '')}`); }
  catch (e) { fail(`syntax error in ${f}:\n${e.stderr}`); }
}

// CSS scoping
const css = readFileSync(join(root, 'src/content/isolated/styles/fixer.css'), 'utf8');
const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((b) => b.split('{')[0].trim()).filter(Boolean);
const unscoped = selectors.filter((s) => !s.startsWith('@') && !/^(from|to|\d+%)$/.test(s) && !s.includes('.cgf-'));
unscoped.length ? fail(`fixer.css has unscoped selectors: ${unscoped.join(' | ')}`) : ok('fixer.css selectors all cgf-scoped');

console.log(failures ? `\n${failures} problem(s)` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

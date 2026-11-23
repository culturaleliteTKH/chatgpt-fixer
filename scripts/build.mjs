// Produce store-ready zips: dist/chatgpt-fixer-chrome.zip and dist/chatgpt-fixer-firefox.zip
import { mkdirSync, rmSync, cpSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const version = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version;
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const target of ['chrome', 'firefox']) {
  const stage = join(dist, target);
  mkdirSync(stage, { recursive: true });
  cpSync(join(root, 'assets'), join(stage, 'assets'), { recursive: true });
  cpSync(join(root, 'src'), join(stage, 'src'), { recursive: true });
  copyFileSync(join(root, target === 'firefox' ? 'manifest.firefox.json' : 'manifest.json'), join(stage, 'manifest.json'));
  const zip = join(dist, `chatgpt-fixer-${target}-v${version}.zip`);
  try {
    execFileSync('zip', ['-qr', zip, '.'], { cwd: stage, stdio: 'inherit' });
    console.log('built', zip);
  } catch {
    console.log(`zip CLI not available; staged folder ready at ${stage}`);
  }
}

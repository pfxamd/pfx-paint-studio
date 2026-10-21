import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolRoot = resolve(root, '.pfx-release-tools');
const packageRoot = resolve(toolRoot, 'node_modules/@pfxamd/release-core');
const expectedVersion = '0.1.0-alpha.4';
const archive = 'https://github.com/pfxamd/pfx-release-core/releases/download/v0.1.0-alpha.4/pfxamd-release-core-0.1.0-alpha.4.tgz';

function installedVersion() {
  try { return JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')).version; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
if (installedVersion() !== expectedVersion || !existsSync(resolve(packageRoot, 'src/index.mjs'))) {
  mkdirSync(toolRoot, { recursive: true });
  writeFileSync(resolve(toolRoot, 'package.json'),
    '{"private":true,"name":"pfx-release-tooling","version":"0.0.0","type":"module"}\n');
  execFileSync('npm', [
    'install', '--prefix', toolRoot, '--ignore-scripts', '--no-save',
    '--package-lock=false', '--no-audit', '--no-fund', archive
  ], { cwd: toolRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  if (installedVersion() !== expectedVersion) throw new Error('PFx Release Core archive version mismatch');
}
const engine = await import(pathToFileURL(resolve(packageRoot, 'src/index.mjs')).href);
export const resolveApplicationRelease = engine.resolveApplicationRelease;

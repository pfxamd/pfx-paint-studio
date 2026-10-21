import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** One deterministic application release, independent of package/core versions. */
export function resolveRelease() {
  const config = JSON.parse(readFileSync(resolve(root, 'release.config.json'), 'utf8'));
  if (git('rev-parse', '--is-shallow-repository') === 'true') {
    throw new Error('Release numbering requires full Git history: git fetch --unshallow');
  }
  git('merge-base', '--is-ancestor', config.baseline, 'HEAD');
  const count = Number(git('rev-list', '--first-parent', '--count', `${config.baseline}..HEAD`, '--', ...config.sourcePaths));
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/.exec(config.baseVersion);
  if (!match || !Number.isSafeInteger(count) || !['Alpha', 'Beta', 'Stable'].includes(config.channel)) {
    throw new Error('Invalid release.config.json or Git release history');
  }
  const version = match[4]
    ? `${match[1]}.${match[2]}.${match[3]}-${match[4]}.${Number(match[5]) + count}`
    : `${match[1]}.${match[2]}.${Number(match[3]) + count}`;
  return { schemaVersion: 1, product: config.product, channel: config.channel,
    version, label: `${config.channel} ${version}`, commit: git('rev-parse', 'HEAD'),
    sourceDate: git('show', '-s', '--format=%cI', 'HEAD') };
}

function stampHtml(html, release) {
  for (const [attribute, value] of [['label', release.label], ['version', release.version]]) {
    const pattern = new RegExp(`(<([a-z][a-z0-9]*)\\b[^>]*\\bdata-pfx-release-${attribute}(?:="[^"]*")?[^>]*>)[^<]*(<\\/\\2>)`, 'gi');
    html = html.replace(pattern, (_, open, tag, close) => open + value + close);
  }
  return html;
}

/** Vite integration: badge constant, static HTML badges and public metadata. */
export function pfxReleasePlugin() {
  const release = resolveRelease();
  return {
    name: 'pfx-application-release',
    config() { return { define: { __PFX_APP_RELEASE__: JSON.stringify(release) } }; },
    transformIndexHtml(html) { return stampHtml(html, release); },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(release, null, 2) + '\n' });
    },
  };
}

/** Static builds call this after assembling their output directory. */
export function writeRelease(outputDirectory) {
  const release = resolveRelease();
  const output = resolve(root, outputDirectory);
  mkdirSync(output, { recursive: true });
  const index = resolve(output, 'index.html');
  writeFileSync(index, stampHtml(readFileSync(index, 'utf8'), release));
  writeFileSync(resolve(output, 'version.json'), JSON.stringify(release, null, 2) + '\n');
  return release;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const output = process.argv[2];
  console.log(output && output !== '--version' ? JSON.stringify(writeRelease(output))
    : output === '--version' ? resolveRelease().version : JSON.stringify(resolveRelease(), null, 2));
}

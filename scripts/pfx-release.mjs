import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveApplicationRelease } from './pfx-release-loader.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Uses the shared PFx engine while retaining the application's public release fields. */
export function resolveRelease() {
  return resolveApplicationRelease(root,
    JSON.parse(readFileSync(resolve(root, 'release.config.json'), 'utf8')));
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

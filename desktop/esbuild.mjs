// Bundle the Electron main and preload entries to CommonJS for Electron.
// `electron` is external (provided by the runtime); everything else this small
// shell uses is a Node built-in, so the bundles stay tiny.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, 'dist-electron');
mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info'
};

await build({
  ...common,
  entryPoints: [path.join(root, 'src', 'main.ts')],
  outfile: path.join(outdir, 'main.cjs')
});

await build({
  ...common,
  entryPoints: [path.join(root, 'src', 'preload.ts')],
  outfile: path.join(outdir, 'preload.cjs')
});

// The splash screen is a static asset loaded by the main process before the
// server is reachable.
copyFileSync(path.join(root, 'src', 'splash.html'), path.join(outdir, 'splash.html'));

console.log('Built desktop/dist-electron (main.cjs, preload.cjs, splash.html)');

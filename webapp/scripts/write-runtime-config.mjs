import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendUrl = process.env.OVERLORD_BACKEND_URL?.trim() ?? '';

if (!backendUrl) {
  console.warn(
    'OVERLORD_BACKEND_URL is unset; the hosted web shell will fall back to same-origin API calls.'
  );
}

const outDir = path.join(here, '..', 'public');
mkdirSync(outDir, { recursive: true });

const payload = JSON.stringify({ apiBaseUrl: backendUrl });
writeFileSync(
  path.join(outDir, 'runtime-config.js'),
  `window.__OVERLORD_RUNTIME__ = ${payload};\n`,
  'utf8'
);

console.log(`Wrote runtime config with apiBaseUrl=${backendUrl || '(same-origin)'}`);

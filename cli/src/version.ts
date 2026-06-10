import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'package.json'
);

export function getCliVersion(): string {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };
  return packageJson.version;
}

export function runVersionCommand({ json = false }: { json?: boolean } = {}): void {
  const version = getCliVersion();

  if (json) {
    console.log(JSON.stringify({ version, node: process.version }));
    return;
  }

  console.log(`Overlord CLI ${version}`);
}

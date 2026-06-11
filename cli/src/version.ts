import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function resolvePackageJsonPath(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      const packageJson = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
      if (packageJson.name === 'overlord-cli') {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  throw new Error('Cannot locate overlord-cli package.json');
}

export function getCliVersion(): string {
  const packageJson = JSON.parse(readFileSync(resolvePackageJsonPath(), 'utf8')) as {
    version: string;
  };
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

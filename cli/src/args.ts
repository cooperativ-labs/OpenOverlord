export type ParsedArgs = {
  positional: string[];
  flags: Map<string, string | true>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;

    if (token === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith('--')) {
      const eqIndex = token.indexOf('=');
      if (eqIndex >= 0) {
        flags.set(token.slice(0, eqIndex), token.slice(eqIndex + 1));
        continue;
      }

      const next = argv[index + 1];
      if (next !== undefined && (!next.startsWith('-') || next === '-')) {
        flags.set(token, next);
        index += 1;
      } else {
        flags.set(token, true);
      }
      continue;
    }

    positional.push(token);
  }

  return { positional, flags };
}

export function flagValue(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === true || value === undefined) return undefined;
  return value;
}

export function flagBoolean(flags: Map<string, string | true>, name: string): boolean {
  return flags.has(name);
}

export function requireFlag(flags: Map<string, string | true>, name: string): string {
  const value = flagValue(flags, name);
  if (!value) {
    throw new Error(`Missing required flag: ${name}`);
  }
  return value;
}

export async function readFlagOrFile({
  flags,
  flagName,
  fileFlagName,
  stdin
}: {
  flags: Map<string, string | true>;
  flagName: string;
  fileFlagName: string;
  stdin?: string;
}): Promise<string | undefined> {
  const direct = flagValue(flags, flagName);
  if (direct) return direct;

  const filePath = flagValue(flags, fileFlagName);
  if (filePath === '-') {
    if (stdin !== undefined) {
      return stdin;
    }
    const { readFileSync } = await import('node:fs');
    return readFileSync(0, 'utf8');
  }
  if (filePath) {
    const { readFileSync } = await import('node:fs');
    return readFileSync(filePath, 'utf8');
  }

  return undefined;
}

export function parseJsonFlag(
  flags: Map<string, string | true>,
  flagName: string
): Record<string, unknown> | undefined {
  const raw = flagValue(flags, flagName);
  if (!raw) return undefined;
  return JSON.parse(raw) as Record<string, unknown>;
}

export function parseCsvFlag(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

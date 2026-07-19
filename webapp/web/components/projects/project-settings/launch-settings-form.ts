export type EnvVarRow = {
  id: string;
  key: string;
  value: string;
};

/** Serialize a launch env-var map to editable `KEY=VALUE` lines (sorted by name). */
export function envVarsToText(vars: Record<string, string> | undefined): string {
  return Object.entries(vars ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/**
 * Parse `KEY=VALUE` lines into a launch env-var map. The name is everything
 * before the first `=` (trimmed); the value is the remainder (trimmed, verbatim
 * otherwise so `{PLACEHOLDER}` tokens survive). Blank lines, lines without `=`,
 * and lines with an empty name are dropped. Later duplicates win.
 */
export function parseEnvVarLines(value: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    vars[key] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

export function parsePreLaunchLines(value: string): string[] {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

/** Lines in `value` that have non-whitespace content but no valid `KEY=`. */
export function invalidEnvVarLines(value: string): string[] {
  const invalid: string[] = [];
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      invalid.push(trimmed);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (!key) invalid.push(trimmed);
  }
  return invalid;
}

export function createEnvVarRow({
  key = '',
  value = ''
}: {
  key?: string;
  value?: string;
} = {}): EnvVarRow {
  return {
    id: crypto.randomUUID(),
    key,
    value
  };
}

export function rowsFromEnvVars(vars: Record<string, string> | undefined): EnvVarRow[] {
  const entries = Object.entries(vars ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return [createEnvVarRow()];
  return entries.map(([key, value]) => createEnvVarRow({ key, value }));
}

export function envVarsFromRows(rows: EnvVarRow[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    vars[key] = row.value;
  }
  return vars;
}

export function normalizeEnvVars(vars: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const key of Object.keys(vars).sort()) {
    normalized[key] = vars[key];
  }
  return normalized;
}

export function envVarsEqual(
  left: Record<string, string>,
  right: Record<string, string>
): boolean {
  return JSON.stringify(normalizeEnvVars(left)) === JSON.stringify(normalizeEnvVars(right));
}

/** Parse clipboard / bulk-paste text into env-var rows. Returns null when invalid. */
export function parseEnvVarPaste(text: string): EnvVarRow[] | null {
  const rows: EnvVarRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return null;
    const key = trimmed.slice(0, eq).trim();
    if (!key) return null;
    rows.push(createEnvVarRow({ key, value: trimmed.slice(eq + 1) }));
  }
  return rows.length > 0 ? rows : null;
}

export function isEnvVarPasteText(text: string): boolean {
  return text.includes('=') && text.split(/\r?\n/).some(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    const eq = trimmed.indexOf('=');
    return eq > 0 && trimmed.slice(0, eq).trim().length > 0;
  });
}

export function mergeEnvVarPasteIntoRows({
  rows,
  rowIndex,
  text
}: {
  rows: EnvVarRow[];
  rowIndex: number;
  text: string;
}): EnvVarRow[] | null {
  const parsed = parseEnvVarPaste(text);
  if (!parsed) return null;
  if (parsed.length === 1) {
    const next = rows.map((row, index) =>
      index === rowIndex ? { ...row, key: parsed[0].key, value: parsed[0].value } : row
    );
    return next;
  }
  return parsed;
}

export const DEFAULT_ENV_VAR_KEY = 'AGENT_POD_EXTRA_ALLOWED_PATHS';

export function appendTokenToEnvVarValue({
  key,
  value,
  token
}: {
  key: string;
  value: string;
  token: string;
}): { key: string; value: string } {
  const nextKey = key.trim() || DEFAULT_ENV_VAR_KEY;
  const nextValue = value.trim() ? `${value}${token}` : token;
  return { key: nextKey, value: nextValue };
}

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { resolveRepoPath } from './config.js';
import { CliError } from './errors.js';

/**
 * Locate the conformance-manifest JSON Schema. The CLI package ships a copy
 * under `dist/contract`, but source checkouts also work — same resolution
 * order as `connectorsRoot()` in `connectors.ts`.
 */
function schemaPath(): string {
  const packaged = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'contract',
    'conformance-manifest.schema.yaml'
  );
  if (existsSync(packaged)) return packaged;

  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, 'contract', 'conformance-manifest.schema.yaml');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return resolveRepoPath('contract/conformance-manifest.schema.yaml');
}

let cachedSchema: Record<string, unknown> | undefined;

function loadSchema(): Record<string, unknown> {
  if (cachedSchema) return cachedSchema;
  const file = schemaPath();
  if (!existsSync(file)) {
    throw new CliError({
      message: `Could not find conformance-manifest.schema.yaml (looked at ${file}).`
    });
  }
  cachedSchema = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>;
  return cachedSchema;
}

type JsonSchema = {
  type?: string;
  required?: string[];
  enum?: unknown[];
  pattern?: string;
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  uniqueItems?: boolean;
};

/**
 * Minimal validator for exactly the JSON Schema subset
 * `conformance-manifest.schema.yaml` uses (type/required/enum/pattern/
 * additionalProperties/properties/items/uniqueItems). Not a general-purpose
 * JSON Schema engine — scoped to this one schema, same philosophy as
 * `parseConnectorManifestYaml` in `connectors.ts`.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  location = '$'
): string[] {
  const errors: string[] = [];

  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [`${location}: must be an object`];
    }
    const obj = value as Record<string, unknown>;

    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined || obj[key] === '') {
        errors.push(`${location}: missing required field "${key}"`);
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          errors.push(`${location}: unexpected field "${key}"`);
        }
      }
    }

    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (obj[key] === undefined) continue;
      errors.push(...validateAgainstSchema(obj[key], propSchema, `${location}.${key}`));
    }
    return errors;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      return [`${location}: must be an array`];
    }
    if (schema.uniqueItems) {
      const seen = new Set<string>();
      value.forEach(item => {
        const key = JSON.stringify(item);
        if (seen.has(key)) errors.push(`${location}: duplicate item ${key}`);
        seen.add(key);
      });
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateAgainstSchema(item, schema.items!, `${location}[${index}]`));
      });
    }
    return errors;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      return [`${location}: must be a string`];
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${location}: must be one of ${schema.enum.join(', ')} (got "${value}")`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${location}: must match pattern ${schema.pattern} (got "${value}")`);
    }
    return errors;
  }

  return errors;
}

export function validateManifest(manifest: unknown): string[] {
  const schema = loadSchema() as unknown as JsonSchema;
  return validateAgainstSchema(manifest, schema, '$');
}

function readManifest(manifestPathArg: string): unknown {
  const resolved = path.resolve(process.cwd(), manifestPathArg);
  if (!existsSync(resolved)) {
    throw new CliError({ message: `Manifest not found: ${manifestPathArg}` });
  }
  return parseYaml(readFileSync(resolved, 'utf8'));
}

function runContractCheck({ args, json }: { args: string[]; json: boolean }): void {
  const manifestPathArg = args.find(arg => !arg.startsWith('--'));
  if (!manifestPathArg) {
    throw new CliError({ message: 'Usage: ovld contract check <manifest-path> [--json]' });
  }

  const manifest = readManifest(manifestPathArg);
  const errors = validateManifest(manifest);
  const valid = errors.length === 0;

  if (json) {
    console.log(JSON.stringify({ valid, manifest: manifestPathArg, errors }, null, 2));
  } else if (valid) {
    console.log(`✓ ${manifestPathArg} conforms to conformance-manifest.schema.yaml`);
  } else {
    console.log(`✗ ${manifestPathArg} does not conform to conformance-manifest.schema.yaml:`);
    for (const error of errors) {
      console.log(`  - ${error}`);
    }
  }

  if (!valid) {
    throw new CliError({ message: `${errors.length} conformance error(s) found.` });
  }
}

export async function runContractCommand({
  subcommand,
  args,
  primaryCommand
}: {
  subcommand: string;
  args: string[];
  primaryCommand: string;
}): Promise<void> {
  const json = args.includes('--json');
  const rest = args.filter(arg => arg !== '--json');

  switch (subcommand) {
    case 'check':
      runContractCheck({ args: rest, json });
      return;
    default:
      throw new CliError({
        message:
          `Unknown contract subcommand: ${subcommand}\n` +
          `Usage: ${primaryCommand} contract check <manifest-path> [--json]`
      });
  }
}

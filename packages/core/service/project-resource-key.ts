import path from 'node:path';

import { slugify } from './util.js';

/** Stable logical key for a project checkout within a project + execution target. */
export function deriveProjectResourceKey({
  resourceKey,
  label,
  directoryPath
}: {
  resourceKey?: string | null;
  label?: string | null;
  directoryPath: string;
}): string {
  const explicit = resourceKey?.trim();
  if (explicit) return slugify(explicit);
  const labelKey = label?.trim();
  if (labelKey) return slugify(labelKey);
  return slugify(path.basename(path.resolve(directoryPath)));
}

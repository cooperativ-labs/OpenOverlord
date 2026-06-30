// The `writeProjectMetadata` capability's implementation: write a linked
// checkout's `.overlord/project.json` on the machine that owns the checkout.
//
// This lives in the local-target module (not projects.ts) so the in-process
// provider can wrap it without a cycle — projects.ts depends on the local-target
// module, never the other way around. The hosted backend must NOT write this to
// its own filesystem; routing through a provider
// makes that automatic — only a co-located in-process provider writes.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { nowIso } from '../util.js';

export const PROJECT_JSON_VERSION = 1;

/**
 * Write `<directoryPath>/.overlord/project.json` (creating the `.overlord`
 * scratch dirs), returning the absolute path written.
 */
export function writeProjectJson({
  directoryPath,
  projectId,
  resourceId,
  isPrimary
}: {
  directoryPath: string;
  projectId: string;
  resourceId: string;
  isPrimary: boolean;
}): string {
  const overlordDir = path.join(directoryPath, '.overlord');
  mkdirSync(overlordDir, { recursive: true });
  mkdirSync(path.join(overlordDir, 'tmp'), { recursive: true });
  mkdirSync(path.join(overlordDir, 'logs'), { recursive: true });

  const projectJsonPath = path.join(overlordDir, 'project.json');
  writeFileSync(
    projectJsonPath,
    `${JSON.stringify(
      {
        version: PROJECT_JSON_VERSION,
        projectId,
        resourceId,
        isPrimary,
        linkedAt: nowIso()
      },
      null,
      2
    )}\n`
  );
  return projectJsonPath;
}

// The `writeProjectMetadata` capability's implementation: write a linked
// checkout's `.overlord/project.json` on the machine that owns the checkout.
//
// This lives in the local-target module (not projects.ts) so the in-process
// provider can wrap it without a cycle — projects.ts depends on the local-target
// module, never the other way around. The hosted backend must NOT write this to
// its own filesystem; routing through a provider
// makes that automatic — only a co-located in-process provider writes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { nowIso } from '../util.js';

export const PROJECT_JSON_VERSION = 2;

export interface ProjectJsonContents {
  _warning: string;
  version: number;
  projectId: string;
  resourceId: string;
  resourceIdsByExecutionTarget?: Record<string, string>;
  isPrimary: boolean;
  linkedAt: string;
}

export interface ReadProjectJsonOptions {
  preferredExecutionTargetId?: string | null;
}

export interface ProjectJsonLink {
  projectId: string;
  resourceId: string;
  resourceIdsByExecutionTarget: Record<string, string>;
  isPrimary: boolean;
}

function parseProjectJson(projectJsonPath: string): ProjectJsonContents | null {
  if (!existsSync(projectJsonPath)) return null;
  const parsed = JSON.parse(readFileSync(projectJsonPath, 'utf8')) as {
    _warning?: unknown;
    version?: unknown;
    projectId?: unknown;
    resourceId?: unknown;
    resourceIdsByExecutionTarget?: unknown;
    isPrimary?: unknown;
    linkedAt?: unknown;
  };
  if (typeof parsed.projectId !== 'string' || typeof parsed.resourceId !== 'string') return null;

  const resourceIdsByExecutionTarget =
    parsed.resourceIdsByExecutionTarget &&
    typeof parsed.resourceIdsByExecutionTarget === 'object' &&
    !Array.isArray(parsed.resourceIdsByExecutionTarget)
      ? Object.fromEntries(
          Object.entries(parsed.resourceIdsByExecutionTarget).filter(
            (entry): entry is [string, string] =>
              typeof entry[0] === 'string' &&
              entry[0].trim().length > 0 &&
              typeof entry[1] === 'string' &&
              entry[1].trim().length > 0
          )
        )
      : {};

  return {
    _warning:
      typeof parsed._warning === 'string'
        ? parsed._warning
        : 'This file is managed by Overlord and is regenerated automatically when this folder is linked as a project resource. Do not edit it manually — manual changes will be overwritten.',
    version: typeof parsed.version === 'number' ? parsed.version : 1,
    projectId: parsed.projectId,
    resourceId: parsed.resourceId,
    resourceIdsByExecutionTarget,
    isPrimary: parsed.isPrimary === true,
    linkedAt: typeof parsed.linkedAt === 'string' ? parsed.linkedAt : nowIso()
  };
}

export function readProjectJsonLink(
  projectJsonPath: string,
  options: ReadProjectJsonOptions = {}
): ProjectJsonLink | null {
  const parsed = parseProjectJson(projectJsonPath);
  if (!parsed) return null;

  const preferredExecutionTargetId = options.preferredExecutionTargetId?.trim() || null;
  const preferredResourceId =
    preferredExecutionTargetId && parsed.resourceIdsByExecutionTarget?.[preferredExecutionTargetId];

  return {
    projectId: parsed.projectId,
    resourceId: preferredResourceId ?? parsed.resourceId,
    resourceIdsByExecutionTarget: parsed.resourceIdsByExecutionTarget ?? {},
    isPrimary: parsed.isPrimary
  };
}

/**
 * Write `<directoryPath>/.overlord/project.json` (creating the `.overlord`
 * scratch dirs), returning the absolute path written.
 */
export function writeProjectJson({
  directoryPath,
  projectId,
  resourceId,
  executionTargetId,
  isPrimary
}: {
  directoryPath: string;
  projectId: string;
  resourceId: string;
  executionTargetId?: string | null;
  isPrimary: boolean;
}): string {
  const overlordDir = path.join(directoryPath, '.overlord');
  mkdirSync(overlordDir, { recursive: true });
  mkdirSync(path.join(overlordDir, 'tmp'), { recursive: true });
  mkdirSync(path.join(overlordDir, 'logs'), { recursive: true });

  const projectJsonPath = path.join(overlordDir, 'project.json');
  const existing = readProjectJsonLink(projectJsonPath);
  const resourceIdsByExecutionTarget = {
    ...(existing?.projectId === projectId ? existing.resourceIdsByExecutionTarget : {})
  };
  if (executionTargetId?.trim()) {
    resourceIdsByExecutionTarget[executionTargetId.trim()] = resourceId;
  }
  writeFileSync(
    projectJsonPath,
    `${JSON.stringify(
      {
        _warning:
          'This file is managed by Overlord and is regenerated automatically when this folder is linked as a project resource. Do not edit it manually — manual changes will be overwritten.',
        version: PROJECT_JSON_VERSION,
        projectId,
        resourceId,
        ...(Object.keys(resourceIdsByExecutionTarget).length > 0
          ? { resourceIdsByExecutionTarget }
          : {}),
        isPrimary,
        linkedAt: nowIso()
      } satisfies ProjectJsonContents,
      null,
      2
    )}\n`
  );
  return projectJsonPath;
}

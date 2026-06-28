import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { ProjectDiscovery } from '../../packages/core/service/projects.ts';
import type { ProjectDto } from '../../webapp/shared/contract.ts';

import type { BackendClient } from './backend-client.js';
import { CliError } from './errors.js';

function readProjectJsonFile(projectJsonPath: string): {
  projectId: string;
  resourceId: string;
  isPrimary: boolean;
} | null {
  if (!existsSync(projectJsonPath)) return null;
  const parsed = JSON.parse(readFileSync(projectJsonPath, 'utf8')) as {
    projectId?: string;
    resourceId?: string;
    isPrimary?: boolean;
  };
  if (!parsed.projectId || !parsed.resourceId) return null;
  return {
    projectId: parsed.projectId,
    resourceId: parsed.resourceId,
    isPrimary: parsed.isPrimary ?? false
  };
}

function discoverProjectJsonFromFilesystem({
  workingDirectory
}: {
  workingDirectory: string;
}): {
  projectId: string;
  resourceId: string;
  resourcePath: string;
  isPrimary: boolean;
} | null {
  let current = path.resolve(workingDirectory);

  while (true) {
    const projectJsonPath = path.join(current, '.overlord', 'project.json');
    const raw = readProjectJsonFile(projectJsonPath);
    if (raw) {
      return {
        projectId: raw.projectId,
        resourceId: raw.resourceId,
        resourcePath: current,
        isPrimary: raw.isPrimary
      };
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

async function resolveProjectByIdOrName({
  backend,
  projectRef
}: {
  backend: BackendClient;
  projectRef: string;
}): Promise<ProjectDto> {
  const trimmed = projectRef.trim();
  const projects = await backend.get<ProjectDto[]>('/api/projects');
  const match =
    projects.find(project => project.id === trimmed) ??
    projects.find(project => project.name === trimmed) ??
    projects.find(project => project.slug === trimmed);
  if (!match) {
    throw new CliError({ message: `Project not found: ${trimmed}` });
  }
  return match;
}

/**
 * Resolve a project from the client filesystem when the backend is remote.
 * The hosted control plane cannot walk the agent machine's directories.
 */
export async function discoverProjectOnClient({
  backend,
  workingDirectory,
  projectId
}: {
  backend: BackendClient;
  workingDirectory: string;
  projectId?: string | null;
}): Promise<ProjectDiscovery> {
  if (projectId?.trim()) {
    const project = await resolveProjectByIdOrName({ backend, projectRef: projectId });
    return {
      projectId: project.id,
      projectName: project.name,
      resourceId: null,
      resourcePath: null,
      isPrimary: false
    };
  }

  const local = discoverProjectJsonFromFilesystem({ workingDirectory });
  if (!local) {
    throw new CliError({
      message: `No linked Overlord project found for ${path.resolve(workingDirectory)}. Run \`ovld add-cwd\` or \`ovld create-project\`.`
    });
  }

  const project = await resolveProjectByIdOrName({ backend, projectRef: local.projectId });
  return {
    projectId: project.id,
    projectName: project.name,
    resourceId: local.resourceId,
    resourcePath: local.resourcePath,
    isPrimary: local.isPrimary
  };
}

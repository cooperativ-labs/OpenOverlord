import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { flagBoolean, flagValue, type ParsedArgs } from './args.js';
import { CliError } from './errors.js';
import { printJson } from './output.js';
import type { CliRuntime } from './runtime.js';

interface OrganizationDto {
  id: string;
  name: string;
  logoUrl: string | null;
}

interface WorkspaceDto {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
}

interface MetaDto {
  organization: OrganizationDto | null;
  organizations: OrganizationDto[];
  workspaces: WorkspaceDto[];
  workspace: WorkspaceDto | null;
}

/** Bare-bones slug suggestion shown to an interactive user; the server derives the canonical one. */
function suggestSlug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 3) || 'org';
}

function promptText({
  question,
  defaultValue
}: {
  question: string;
  defaultValue?: string;
}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise<string>(resolve => {
    rl.question(`${question}${suffix}: `, answer => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue || '');
    });
  });
}

const DEFAULT_WORKSPACE_NAME = 'general';

/**
 * `ovld org-setup`: creates an organization + first workspace for an
 * authenticated user with zero workspace memberships, via the same
 * `POST /api/onboarding` endpoint the web onboarding screen uses, so the two
 * clients cannot drift (planning/feature-plans/organization-workspace-hierarchy.md,
 * Phase 5). A failed logo upload is a warning, not a rollback.
 */
export async function runOrgSetupCommand({
  runtime,
  parsed
}: {
  runtime: CliRuntime;
  parsed: ParsedArgs;
}): Promise<void> {
  const json = flagBoolean(parsed.flags, '--json');
  const noInput = flagBoolean(parsed.flags, '--no-input');
  const ifNeeded = flagBoolean(parsed.flags, '--if-needed');
  const interactive = !noInput && process.stdin.isTTY;

  const existingMeta = await runtime.backend.get<MetaDto>('/api/meta');
  if (existingMeta.organizations.length > 0) {
    if (ifNeeded) {
      if (json) printJson({ skipped: true, reason: 'already has organization memberships' });
      else console.log('Already a member of an organization — nothing to do (--if-needed).');
      return;
    }
    throw new CliError({
      message:
        'You already belong to at least one organization, so `ovld org-setup` does not apply.\n' +
        'Use `ovld create-project` to add a project to an existing workspace instead.'
    });
  }

  let organizationName = flagValue(parsed.flags, '--org-name');
  if (!organizationName && interactive) {
    organizationName = await promptText({ question: 'Organization name' });
  }
  if (!organizationName) {
    throw new CliError({ message: 'Missing --org-name' });
  }

  let workspaceName = flagValue(parsed.flags, '--workspace-name');
  if (!workspaceName && interactive) {
    workspaceName = await promptText({
      question: 'Workspace name',
      defaultValue: DEFAULT_WORKSPACE_NAME
    });
  }
  workspaceName = workspaceName || DEFAULT_WORKSPACE_NAME;

  let workspaceSlug = flagValue(parsed.flags, '--workspace-slug');
  if (!workspaceSlug && interactive) {
    workspaceSlug = await promptText({
      question: 'Workspace slug (advanced, leave blank to auto-derive)',
      defaultValue: suggestSlug(workspaceName)
    });
    if (workspaceSlug === suggestSlug(workspaceName)) workspaceSlug = undefined;
  }

  const meta = await runtime.backend.post<MetaDto>({
    path: '/api/onboarding',
    body: {
      organizationName,
      workspaceName,
      ...(workspaceSlug ? { workspaceSlug } : {})
    }
  });

  const organization = meta.organization;
  const workspace = meta.workspace;
  if (!organization) {
    throw new CliError({ message: 'Onboarding succeeded but returned no organization.' });
  }

  const logoPath = flagValue(parsed.flags, '--logo');
  let logoWarning: string | null = null;
  if (logoPath) {
    try {
      const resolvedPath = path.resolve(logoPath);
      const bytes = readFileSync(resolvedPath);
      const stored = await runtime.backend.postRaw<{ url: string }>({
        path: '/api/uploads/organization-images',
        body: bytes,
        filename: path.basename(resolvedPath)
      });
      await runtime.backend.patch({
        path: `/api/organizations/${encodeURIComponent(organization.id)}`,
        body: { logoUrl: stored.url }
      });
    } catch (error) {
      logoWarning = error instanceof Error ? error.message : String(error);
    }
  }

  if (json) {
    printJson({ organization, workspace, logoWarning });
    return;
  }

  console.log(`Created organization "${organization.name}" (${organization.id})`);
  if (workspace) console.log(`Created workspace "${workspace.name}" (${workspace.slug})`);
  if (logoWarning) console.warn(`Warning: logo upload failed — ${logoWarning}`);
}

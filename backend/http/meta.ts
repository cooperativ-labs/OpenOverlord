/**
 * Assembles the `GET /api/meta` response shape (`MetaDto`): the caller's
 * active organization, every organization they belong to, the accessible
 * workspaces of the active organization, and the server's default-scope
 * workspace. Shared by the `/api/meta` route and the onboarding routes (which
 * return the refreshed meta after creating the caller's first
 * organization/workspace) so the shape can never drift between the two.
 *
 * Deliberately depends on both `organizations.ts` and `workspaces.ts` (rather
 * than living in either) so neither service module needs to import the other.
 */

import type { MetaDto } from '../../webapp/shared/contract.ts';

import { getActiveProfileId, getActiveWorkspaceIdOrNull } from '../db.ts';
import { getActiveOrganizationIdOrNull, listOrganizationsForUser } from '../organizations.ts';
import { listWorkspacesForOrganization } from '../workspaces.ts';

export async function buildMeta(): Promise<MetaDto> {
  const profileId = getActiveProfileId();
  const activeOrganizationId = await getActiveOrganizationIdOrNull();
  const organizations = profileId ? await listOrganizationsForUser(profileId) : [];
  const organization = organizations.find(org => org.isActive) ?? null;
  const workspaces = activeOrganizationId
    ? await listWorkspacesForOrganization(activeOrganizationId)
    : [];
  const activeWorkspaceId = getActiveWorkspaceIdOrNull();
  const workspace = activeWorkspaceId ? (workspaces.find(w => w.isActive) ?? null) : null;

  return { organization, organizations, workspaces, workspace };
}

import { Role, RoleDefinition } from './types.js';

/** Default role definitions shipped with Overlord.
 *
 *  These can be overridden by an `Overlord.rbac.toml` config file or
 *  replaced entirely by a custom authorization provider.
 */
export const DEFAULT_ROLE_DEFINITIONS: Readonly<Record<Role, RoleDefinition>> = {
  [Role.ADMIN]: {
    description: 'Full instance administrator',
    grants: ['*']
  },
  [Role.MANAGER]: {
    description: 'Manages the workspace and its members/projects, short of full admin',
    grants: [
      'workspace:read',
      'workspace:update',
      'workspace:activate',
      'member:invite',
      'member:remove',
      'invitation:read',
      'invitation:revoke',
      'profile:self:*',
      'launch:*',
      'project:*',
      'mission:*',
      'objective:*',
      'session:*',
      'event:create',
      'event:read',
      'artifact:*',
      'workspace_image:read',
      'organization_image:read',
      'user_image:read',
      'user_image:self:*',
      'attachment:*',
      'user_token:self:*',
      'execution_request:create',
      'execution_request:read',
      'execution_request:claim'
    ]
  },
  [Role.MEMBER]: {
    description: 'Standard user or persistent agent account',
    grants: [
      'workspace:read',
      // Switching the caller's own active workspace. `activateWorkspace`
      // independently validates the caller is an active member of the *target*
      // workspace, so this only lets a member move between workspaces they
      // already belong to — never join one they don't. Without it, an invited
      // MEMBER can never switch into (or back out of) a workspace via the
      // gated `/api/workspaces/:id/activate` route.
      'workspace:activate',
      'profile:self:*',
      'launch:*',
      'project:read',
      'mission:*',
      'objective:*',
      'session:*',
      'event:create',
      'event:read',
      'artifact:*',
      'workspace_image:read',
      'organization_image:read',
      'user_image:read',
      'user_image:self:*',
      'attachment:*',
      'user_token:self:*',
      'execution_request:create',
      'execution_request:read',
      'execution_request:claim'
    ]
  },
  [Role.PUBLIC]: {
    description: 'Unauthenticated public read access',
    grants: ['workspace_image:read', 'organization_image:read', 'user_image:read']
  }
};

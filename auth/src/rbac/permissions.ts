/** Canonical domain-oriented permission names.
 *
 *  Use these constants instead of raw strings so that typos are caught at
 *  compile time and the permission surface stays easy to grep.
 */
export const PERMISSIONS = {
  // Workspaces (read is member-level; create/update/delete/activate are admin)
  WORKSPACE_READ: 'workspace:read',
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_UPDATE: 'workspace:update',
  WORKSPACE_DELETE: 'workspace:delete',
  WORKSPACE_ACTIVATE: 'workspace:activate',

  // Own account profile
  PROFILE_SELF_READ: 'profile:self:read',
  PROFILE_SELF_UPDATE: 'profile:self:update',

  // Launch configuration (agent catalog, launch settings, terminal/launch prefs)
  LAUNCH_READ: 'launch:read',
  LAUNCH_CONFIGURE: 'launch:configure',

  // Projects
  PROJECT_CREATE: 'project:create',
  PROJECT_READ: 'project:read',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',

  // Missions
  MISSION_CREATE: 'mission:create',
  MISSION_READ: 'mission:read',
  MISSION_UPDATE: 'mission:update',
  MISSION_DELETE: 'mission:delete',

  // Objectives
  OBJECTIVE_SUBMIT: 'objective:submit',
  OBJECTIVE_READ: 'objective:read',
  OBJECTIVE_UPDATE: 'objective:update',

  // Sessions
  SESSION_ATTACH: 'session:attach',
  SESSION_READ: 'session:read',

  // Events
  EVENT_CREATE: 'event:create',
  EVENT_READ: 'event:read',

  // Artifacts
  ARTIFACT_READ: 'artifact:read',
  ARTIFACT_CREATE: 'artifact:create',
  ARTIFACT_DELETE: 'artifact:delete',

  // Storage: public workspace images, self-managed user images, and member attachments
  WORKSPACE_IMAGE_READ: 'workspace_image:read',
  WORKSPACE_IMAGE_CREATE: 'workspace_image:create',
  WORKSPACE_IMAGE_UPDATE: 'workspace_image:update',
  WORKSPACE_IMAGE_DELETE: 'workspace_image:delete',
  USER_IMAGE_READ: 'user_image:read',
  USER_IMAGE_CREATE: 'user_image:create',
  USER_IMAGE_UPDATE: 'user_image:update',
  USER_IMAGE_DELETE: 'user_image:delete',
  USER_IMAGE_SELF_CREATE: 'user_image:self:create',
  USER_IMAGE_SELF_UPDATE: 'user_image:self:update',
  USER_IMAGE_SELF_DELETE: 'user_image:self:delete',
  ATTACHMENT_READ: 'attachment:read',
  ATTACHMENT_CREATE: 'attachment:create',
  ATTACHMENT_UPDATE: 'attachment:update',
  ATTACHMENT_DELETE: 'attachment:delete',

  // Execution requests
  EXECUTION_REQUEST_CREATE: 'execution_request:create',
  EXECUTION_REQUEST_READ: 'execution_request:read',
  EXECUTION_REQUEST_CLAIM: 'execution_request:claim',

  // User management (ADMIN-only by default)
  USER_CREATE: 'user:create',
  USER_READ: 'user:read',
  USER_UPDATE: 'user:update',
  USER_DISABLE: 'user:disable',
  USER_DELETE: 'user:delete',

  // Role management (ADMIN-only by default)
  ROLE_ASSIGN: 'role:assign',
  ROLE_REVOKE: 'role:revoke',

  // Connector configuration (ADMIN-only by default)
  CONNECTOR_CONFIGURE: 'connector:configure',

  // User token self-management (own tokens only)
  USER_TOKEN_SELF_CREATE: 'user_token:self:create',
  USER_TOKEN_SELF_LIST: 'user_token:self:list',
  USER_TOKEN_SELF_ROTATE: 'user_token:self:rotate',
  USER_TOKEN_SELF_REVOKE: 'user_token:self:revoke',

  // Workspace member invitations (ADMIN-only by default)
  MEMBER_INVITE: 'member:invite',
  MEMBER_REMOVE: 'member:remove',
  INVITATION_READ: 'invitation:read',
  INVITATION_REVOKE: 'invitation:revoke',

  // Organizations. Org-level mutations are gated by the derived org-admin
  // invariant (`isOrganizationAdmin`), not a distinct role, so these permission
  // constants exist for route-level documentation/consistency; the real gate
  // runs inside the `backend/organizations.ts` service functions themselves.
  ORGANIZATION_READ: 'organization:read',
  ORGANIZATION_UPDATE: 'organization:update',
  ORGANIZATION_ADMIN_MANAGE: 'organization:admin_manage',
  ORGANIZATION_IMAGE_READ: 'organization_image:read',
  ORGANIZATION_IMAGE_CREATE: 'organization_image:create',

  // Webhook subscription management (ADMIN-only by default)
  WEBHOOK_CREATE: 'webhook:create',
  WEBHOOK_READ: 'webhook:read',
  WEBHOOK_UPDATE: 'webhook:update',
  WEBHOOK_DELETE: 'webhook:delete'
} as const;

export type KnownPermission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Token scope presets surfaced to the CLI (`--scope`) and the webapp token form.
 *
 *  - `full` carries no scope rows, so the token inherits the full permissions of
 *    its creating user's roles.
 *  - `mission_lifecycle` restricts the token to everything a runner/agent needs to
 *    drive a mission — workspace, project (read + create), mission, objective, session,
 *    event, artifact, attachment, and execution-request work. Project *create* is
 *    permitted so agents (including hosted MCP) can spin up a new project to work in;
 *    it deliberately still excludes project update/delete and user/role/connector
 *    administration and `user_token:self:*` (a scoped token must not be able to mint
 *    further tokens).
 *
 *  Stored grants are wildcard patterns matched by `grantCoversAction`. A token's
 *  effective permissions are always its creating user's role grants intersected
 *  with these scope grants, so a scope can only ever restrict, never widen, access.
 */
export type TokenScope = 'full' | 'mission_lifecycle';

export const MISSION_LIFECYCLE_GRANTS: readonly string[] = [
  'workspace:read',
  'project:read',
  'project:create',
  'mission:*',
  'objective:*',
  'session:*',
  'event:create',
  'event:read',
  'artifact:*',
  'attachment:*',
  'execution_request:create',
  'execution_request:read',
  'execution_request:claim'
] as const;

/**
 * Resolve the scope grant patterns to persist for a given preset. `full` returns
 * an empty list — no `user_token_scopes` rows, meaning no token-level restriction.
 */
export function scopeGrantsForPreset(scope: TokenScope): string[] {
  return scope === 'mission_lifecycle' ? [...MISSION_LIFECYCLE_GRANTS] : [];
}

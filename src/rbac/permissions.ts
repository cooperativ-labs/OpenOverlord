/** Canonical domain-oriented permission names.
 *
 *  Use these constants instead of raw strings so that typos are caught at
 *  compile time and the permission surface stays easy to grep.
 */
export const PERMISSIONS = {
  // Projects
  PROJECT_CREATE: 'project:create',
  PROJECT_READ: 'project:read',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',

  // Tickets
  TICKET_CREATE: 'ticket:create',
  TICKET_READ: 'ticket:read',
  TICKET_UPDATE: 'ticket:update',
  TICKET_DELETE: 'ticket:delete',

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
} as const;

export type KnownPermission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export type { AuthorizationProvider } from './authorizer.js';
export {
  Authorizer,
  can,
  defaultAuthorizer,
  grantCoversAction,
  makeActor,
  tokenScopeAllows
} from './authorizer.js';
export type { KnownPermission, TokenScope } from './permissions.js';
export { MISSION_LIFECYCLE_GRANTS, PERMISSIONS, scopeGrantsForPreset } from './permissions.js';
export { DEFAULT_ROLE_DEFINITIONS } from './roles.js';
export type { Actor, AuthorizationResult, Permission, RoleDefinition } from './types.js';
export { Role } from './types.js';

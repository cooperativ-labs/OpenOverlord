export { Role } from './types.js';
export type { Actor, AuthorizationResult, Permission, RoleDefinition } from './types.js';
export { PERMISSIONS } from './permissions.js';
export type { KnownPermission } from './permissions.js';
export { DEFAULT_ROLE_DEFINITIONS } from './roles.js';
export { Authorizer, defaultAuthorizer, can, makeActor } from './authorizer.js';
export type { AuthorizationProvider } from './authorizer.js';

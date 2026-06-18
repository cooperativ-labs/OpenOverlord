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
  [Role.MEMBER]: {
    description: 'Standard user or persistent agent account',
    grants: [
      'workspace:read',
      'profile:self:*',
      'launch:*',
      'project:read',
      'ticket:*',
      'objective:*',
      'session:*',
      'event:create',
      'event:read',
      'artifact:*',
      'workspace_image:read',
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
    grants: ['workspace_image:read', 'user_image:read']
  }
};

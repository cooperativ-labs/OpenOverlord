import { Role, RoleDefinition } from './types.js';

/** Default role definitions shipped with OpenOverlord.
 *
 *  These can be overridden by an `openoverlord.rbac.toml` config file or
 *  replaced entirely by a custom authorization provider.
 */
export const DEFAULT_ROLE_DEFINITIONS: Readonly<Record<Role, RoleDefinition>> =
  {
    [Role.ADMIN]: {
      description: 'Full instance administrator',
      grants: ['*'],
    },
    [Role.MEMBER]: {
      description: 'Standard user or persistent agent account',
      grants: [
        'project:read',
        'ticket:*',
        'objective:*',
        'session:*',
        'event:create',
        'event:read',
        'artifact:*',
        'user_token:self:*',
        'execution_request:create',
        'execution_request:read',
        'execution_request:claim',
      ],
    },
  };

import { Actor, AuthorizationResult, Permission, Role, RoleDefinition } from './types.js';
import { DEFAULT_ROLE_DEFINITIONS } from './roles.js';

/**
 * Check whether a single grant pattern covers the requested action.
 *
 * Supported wildcard forms:
 *   *                 → matches everything
 *   ticket:*          → matches any action in the ticket namespace
 *   user_token:self:* → matches any self-scoped token action
 */
function grantCoversAction(grant: string, action: string): boolean {
  if (grant === '*') return true;
  if (grant === action) return true;

  if (grant.endsWith(':*')) {
    const prefix = grant.slice(0, -1); // "ticket:" or "user_token:self:"
    return action.startsWith(prefix);
  }

  return false;
}

/**
 * Check whether a role's grants cover the requested action.
 */
function roleAllows(roleDef: RoleDefinition, action: string): boolean {
  return roleDef.grants.some((g) => grantCoversAction(g, action));
}

/**
 * The core authorization interface.
 *
 * Business logic should call `can()` rather than inspecting role names
 * directly. This keeps policy details in one place and makes the
 * authorization layer replaceable without touching callers.
 */
export interface AuthorizationProvider {
  can(actor: Actor, action: Permission): AuthorizationResult;
}

/**
 * Config-backed authorization provider.
 *
 * Uses role definitions supplied at construction time (defaulting to the
 * built-in ADMIN/MEMBER definitions). Each role in the actor's `roles` array
 * is checked in order; access is granted if any role permits the action.
 */
export class Authorizer implements AuthorizationProvider {
  private readonly roleDefs: Readonly<Record<string, RoleDefinition>>;

  constructor(
    roleDefs: Readonly<Record<string, RoleDefinition>> = DEFAULT_ROLE_DEFINITIONS,
  ) {
    this.roleDefs = roleDefs;
  }

  can(actor: Actor, action: Permission): AuthorizationResult {
    if (actor.roles.length === 0) {
      return { allowed: false, reason: `Actor ${actor.workspaceUserId} has no roles assigned` };
    }

    for (const role of actor.roles) {
      const def = this.roleDefs[role];
      if (!def) {
        continue; // unknown role — skip rather than grant
      }
      if (roleAllows(def, action)) {
        return {
          allowed: true,
          reason: `Role ${role} grants ${action}`,
        };
      }
    }

    return {
      allowed: false,
      reason: `None of [${actor.roles.join(', ')}] grant ${action}`,
    };
  }
}

/**
 * Convenience singleton that uses the default built-in role definitions.
 * Replace this with a custom `Authorizer` instance (or a different
 * `AuthorizationProvider` implementation) when loading from config.
 */
export const defaultAuthorizer = new Authorizer();

/**
 * Convenience wrapper around the default authorizer.
 *
 * @example
 *   if (!can(actor, PERMISSIONS.USER_CREATE).allowed) throw new Forbidden();
 */
export function can(actor: Actor, action: Permission): AuthorizationResult {
  return defaultAuthorizer.can(actor, action);
}

/**
 * Build an Actor for a workspace user given their current role assignments.
 * The caller is responsible for fetching roles from the database.
 */
export function makeActor(workspaceUserId: string, roles: Role[]): Actor {
  return { workspaceUserId, roles };
}

export type Permission = string;

export enum Role {
  ADMIN = 'ADMIN',
  /**
   * Between MEMBER and ADMIN: can update the workspace itself and manage
   * members/invitations, but capped at MANAGER — it may neither grant ADMIN
   * nor demote/remove an existing ADMIN (enforced server-side, not just by
   * omission from its grants).
   */
  MANAGER = 'MANAGER',
  MEMBER = 'MEMBER',
  PUBLIC = 'PUBLIC'
}

export interface RoleDefinition {
  description: string;
  grants: Permission[];
}

/** Minimal actor identity needed for authorization checks. */
export interface Actor {
  workspaceUserId: string;
  roles: Role[];
}

export interface AuthorizationResult {
  allowed: boolean;
  /** Human-readable reason, suitable for CLI output or API error messages. */
  reason: string;
}

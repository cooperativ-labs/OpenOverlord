export type Permission = string;

export enum Role {
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
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

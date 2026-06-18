export const SEED_WORKSPACE_ID = 'local-workspace';
export const SEED_WORKSPACE_SLUG = 'local';
export const SEED_WORKSPACE_USER_ID = 'local-workspace-user';
export const SEED_USER_ID = 'local-user';
export const CONTRACT_VERSION = '0.21-draft';

export const DEFAULT_STATUSES = [
  {
    key: 'backlog',
    name: 'Backlog',
    type: 'draft',
    position: 0,
    isDefault: true,
    isTerminal: false
  },
  {
    key: 'next_up',
    name: 'Next Up',
    type: 'draft',
    position: 1,
    isDefault: false,
    isTerminal: false
  },
  {
    key: 'in_progress',
    name: 'In Progress',
    type: 'execute',
    position: 2,
    isDefault: false,
    isTerminal: false
  },
  {
    key: 'in_review',
    name: 'In Review',
    type: 'review',
    position: 3,
    isDefault: false,
    isTerminal: false
  },
  { key: 'done', name: 'Done', type: 'complete', position: 4, isDefault: false, isTerminal: true },
  {
    key: 'blocked',
    name: 'Blocked',
    type: 'blocked',
    position: 5,
    isDefault: false,
    isTerminal: false
  },
  {
    key: 'cancelled',
    name: 'Cancelled',
    type: 'cancelled',
    position: 6,
    isDefault: false,
    isTerminal: true
  }
] as const;

export const OBJECTIVE_STATES = [
  'future',
  'draft',
  'submitted',
  'launching',
  'executing',
  'pending_delivery',
  'complete'
] as const;

export type ObjectiveState = (typeof OBJECTIVE_STATES)[number];

export const UPDATE_PHASES = [
  'draft',
  'execute',
  'review',
  'deliver',
  'complete',
  'blocked',
  'cancelled'
] as const;

export const UPDATE_EVENT_TYPES = [
  'update',
  'user_follow_up',
  'alert',
  'discussion_summary',
  'decision'
] as const;

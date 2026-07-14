const ACTIVE_ORGANIZATION_STORAGE_PREFIX = 'overlord:active-organization';
const WORKSPACE_COLLAPSE_STORAGE_PREFIX = 'overlord:workspace-collapse';
const MY_MISSIONS_WORKSPACE_FILTER_STORAGE_PREFIX = 'overlord:my-missions-workspace-filter';

function storageKey(prefix: string, backendKey: string): string {
  return `${prefix}:${backendKey}`;
}

function readBackendScopedKey(prefix: string): string | null {
  if (typeof window === 'undefined') return null;
  const backendKey = window.localStorage.getItem('overlord:active-backend-key');
  if (!backendKey) return null;
  try {
    return window.localStorage.getItem(storageKey(prefix, backendKey));
  } catch {
    return null;
  }
}

function writeBackendScopedKey(prefix: string, value: string): void {
  if (typeof window === 'undefined') return;
  const backendKey = window.localStorage.getItem('overlord:active-backend-key');
  if (!backendKey) return;
  try {
    window.localStorage.setItem(storageKey(prefix, backendKey), value);
  } catch {
    /* localStorage may be unavailable */
  }
}

function removeBackendScopedKey(prefix: string): void {
  if (typeof window === 'undefined') return;
  const backendKey = window.localStorage.getItem('overlord:active-backend-key');
  if (!backendKey) return;
  try {
    window.localStorage.removeItem(storageKey(prefix, backendKey));
  } catch {
    /* localStorage may be unavailable */
  }
}

/** Persist the UI's selected organization id (preference echo; server scope follows active workspace). */
export function persistActiveOrganizationId(organizationId: string): void {
  writeBackendScopedKey(ACTIVE_ORGANIZATION_STORAGE_PREFIX, organizationId);
}

export function readActiveOrganizationId(): string | null {
  return readBackendScopedKey(ACTIVE_ORGANIZATION_STORAGE_PREFIX);
}

export function clearActiveOrganizationId(): void {
  removeBackendScopedKey(ACTIVE_ORGANIZATION_STORAGE_PREFIX);
}

function collapseStorageKey(organizationId: string): string {
  const backendKey =
    typeof window !== 'undefined'
      ? (window.localStorage.getItem('overlord:active-backend-key') ?? 'default')
      : 'default';
  return `${WORKSPACE_COLLAPSE_STORAGE_PREFIX}:${backendKey}:${organizationId}`;
}

type WorkspaceCollapseState = Record<string, boolean>;

function readCollapseState(organizationId: string): WorkspaceCollapseState {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(collapseStorageKey(organizationId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as WorkspaceCollapseState) : {};
  } catch {
    return {};
  }
}

function writeCollapseState(organizationId: string, state: WorkspaceCollapseState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(collapseStorageKey(organizationId), JSON.stringify(state));
  } catch {
    /* localStorage may be unavailable */
  }
}

/** Whether a workspace section is expanded in the sidebar (default expanded). */
export function isWorkspaceSectionExpanded({
  organizationId,
  workspaceId
}: {
  organizationId: string;
  workspaceId: string;
}): boolean {
  const state = readCollapseState(organizationId);
  const stored = state[workspaceId];
  return stored === undefined ? true : stored;
}

export function setWorkspaceSectionExpanded({
  organizationId,
  workspaceId,
  expanded
}: {
  organizationId: string;
  workspaceId: string;
  expanded: boolean;
}): void {
  const state = readCollapseState(organizationId);
  state[workspaceId] = expanded;
  writeCollapseState(organizationId, state);
}

function myMissionsWorkspaceFilterStorageKey(organizationId: string): string {
  const backendKey =
    typeof window !== 'undefined'
      ? (window.localStorage.getItem('overlord:active-backend-key') ?? 'default')
      : 'default';
  return `${MY_MISSIONS_WORKSPACE_FILTER_STORAGE_PREFIX}:${backendKey}:${organizationId}`;
}

/** Read the device-local My Missions workspace filter for one organization. */
export function readMyMissionsWorkspaceFilter(organizationId: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(myMissionsWorkspaceFilterStorageKey(organizationId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every(id => typeof id === 'string')) return [];
    return [...new Set(parsed)];
  } catch {
    return [];
  }
}

/** Persist the device-local My Missions workspace filter for one organization. */
export function writeMyMissionsWorkspaceFilter(
  organizationId: string,
  workspaceIds: string[]
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      myMissionsWorkspaceFilterStorageKey(organizationId),
      JSON.stringify([...new Set(workspaceIds)])
    );
  } catch {
    /* localStorage may be unavailable */
  }
}

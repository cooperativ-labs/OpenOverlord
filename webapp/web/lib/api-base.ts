export type DesktopBackendMode = 'local' | 'remote';

export type DesktopBackendInfo = {
  id: string;
  label: string;
  mode: DesktopBackendMode;
  backendUrl: string;
  apiBaseUrl: string;
  shellOrigin: string;
};

let activeBackend: DesktopBackendInfo | null = null;
let userToken: string | null = null;
let sessionToken: string | null = null;

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function isRemoteBackend(): boolean {
  if (!activeBackend) return false;
  return activeBackend.mode === 'remote';
}

export function getApiBaseUrl(): string {
  if (!activeBackend) return '';
  return trimTrailingSlash(activeBackend.apiBaseUrl);
}

export function getActiveBackendInfo(): DesktopBackendInfo | null {
  return activeBackend;
}

export function resolveApiUrl(path: string): string {
  const base = getApiBaseUrl();
  if (!base) return path;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function getAuthBaseUrl(): string {
  const base = getApiBaseUrl();
  return base || (typeof window !== 'undefined' ? window.location.origin : '');
}

async function loadStoredTokensForActiveBackend(): Promise<void> {
  const bridge = window.overlord;
  if (!activeBackend || !bridge) return;

  if (bridge.getSessionToken) {
    sessionToken = await bridge.getSessionToken(activeBackend.id);
  }
  if (bridge.getBearerToken) {
    userToken = await bridge.getBearerToken(activeBackend.id);
  }
}

export async function initDesktopApiConfig(): Promise<void> {
  const bridge = typeof window === 'undefined' ? undefined : window.overlord;
  if (!bridge?.getActiveBackend) return;

  activeBackend = await bridge.getActiveBackend();
  await loadStoredTokensForActiveBackend();
}

function resolveAuthorizationToken(): string | null {
  return userToken ?? sessionToken;
}

export function getAuthorizationHeader(): Record<string, string> | undefined {
  const token = resolveAuthorizationToken();
  if (!token) return undefined;
  return { Authorization: `Bearer ${token}` };
}

/** @deprecated Use getAuthorizationHeader */
export function getBearerAuthorizationHeader(): Record<string, string> | undefined {
  return getAuthorizationHeader();
}

export function getDesktopSessionToken(): string {
  return sessionToken ?? '';
}

export async function persistDesktopSessionToken(token: string): Promise<void> {
  sessionToken = token.trim();
  const bridge = window.overlord;
  if (!activeBackend || !bridge?.setSessionToken) return;
  await bridge.setSessionToken({ profileId: activeBackend.id, token: sessionToken });
}

export async function persistDesktopBearerToken(token: string): Promise<void> {
  userToken = token.trim();
  const bridge = window.overlord;
  if (!activeBackend || !bridge?.setBearerToken) return;
  await bridge.setBearerToken({ profileId: activeBackend.id, token: userToken });
}

export function isCurrentDesktopBearerTokenPrefix(tokenPrefix: string | null | undefined): boolean {
  const prefix = tokenPrefix?.trim();
  return Boolean(prefix && userToken?.startsWith(prefix));
}

export async function clearDesktopBearerToken(): Promise<void> {
  userToken = null;
  const bridge = window.overlord;
  if (!activeBackend || !bridge?.clearBearerToken) return;
  await bridge.clearBearerToken(activeBackend.id);
}

export async function clearDesktopAuthTokens(): Promise<void> {
  userToken = null;
  sessionToken = null;
  const bridge = window.overlord;
  if (!activeBackend) return;
  if (bridge?.clearBearerToken) await bridge.clearBearerToken(activeBackend.id);
  if (bridge?.clearSessionToken) await bridge.clearSessionToken(activeBackend.id);
}

export function apiFetchCredentials(): RequestCredentials {
  return resolveAuthorizationToken() ? 'omit' : 'include';
}

export function clearInMemoryAuthTokens(): void {
  userToken = null;
  sessionToken = null;
}

export function captureAuthTokenFromResponse(response: Response): void {
  const token = response.headers.get('set-auth-token');
  if (!token) return;
  void persistDesktopSessionToken(token);
}

/** Better Auth returns the session token in sign-in/sign-up JSON for bearer clients. */
export async function persistAuthSessionFromSignInResult(data: unknown): Promise<void> {
  if (!data || typeof data !== 'object' || !('token' in data)) return;
  const token = (data as { token?: unknown }).token;
  if (typeof token !== 'string' || token.trim().length === 0) return;
  await persistDesktopSessionToken(token);
}

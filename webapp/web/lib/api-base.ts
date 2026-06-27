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
let bearerToken: string | null = null;

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

export async function initDesktopApiConfig(): Promise<void> {
  const bridge = typeof window === 'undefined' ? undefined : window.overlord;
  if (!bridge?.getActiveBackend) return;

  activeBackend = await bridge.getActiveBackend();
  if (activeBackend.mode === 'remote' && bridge.getBearerToken) {
    bearerToken = await bridge.getBearerToken(activeBackend.id);
  }
}

export function getBearerAuthorizationHeader(): Record<string, string> | undefined {
  if (!bearerToken) return undefined;
  return { Authorization: `Bearer ${bearerToken}` };
}

export async function persistDesktopBearerToken(token: string): Promise<void> {
  bearerToken = token.trim();
  const bridge = window.overlord;
  if (!activeBackend || !bridge?.setBearerToken) return;
  await bridge.setBearerToken({ profileId: activeBackend.id, token: bearerToken });
}

export async function clearDesktopBearerToken(): Promise<void> {
  bearerToken = null;
  const bridge = window.overlord;
  if (!activeBackend || !bridge?.clearBearerToken) return;
  await bridge.clearBearerToken(activeBackend.id);
}

export function apiFetchCredentials(): RequestCredentials {
  return isRemoteBackend() ? 'include' : 'same-origin';
}

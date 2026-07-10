const PUBLIC_BACKEND_URL_ENV_KEYS = [
  'BETTER_AUTH_URL',
  'BACKEND_URL',
  'OVERLORD_BACKEND_URL'
] as const;

/** Normalize a configured backend/auth URL to a browser origin (scheme + host + port). */
export function normalizeOriginUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return new URL(withScheme).origin;
}

/** Public backend origins from env, in precedence order, without duplicates. */
export function readConfiguredPublicBackendUrls(): string[] {
  const origins: string[] = [];
  const seen = new Set<string>();

  for (const key of PUBLIC_BACKEND_URL_ENV_KEYS) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;

    const origin = normalizeOriginUrl(raw);
    if (seen.has(origin)) continue;
    seen.add(origin);
    origins.push(origin);
  }

  return origins;
}

export function resolveLoopbackAuthBaseUrl(): string {
  const authBaseHost =
    process.env.OVERLORD_WEB_HOST && process.env.OVERLORD_WEB_HOST !== '0.0.0.0'
      ? process.env.OVERLORD_WEB_HOST
      : '127.0.0.1';
  const authBasePort = process.env.OVERLORD_WEB_PORT ?? '4310';
  return `http://${authBaseHost}:${authBasePort}`;
}

/** Better Auth public base URL; prefers BETTER_AUTH_URL, then BACKEND_URL, then OVERLORD_BACKEND_URL. */
export function resolveAuthBaseUrl(): string {
  const configured = readConfiguredPublicBackendUrls();
  if (configured.length > 0) return configured[0];
  return resolveLoopbackAuthBaseUrl();
}

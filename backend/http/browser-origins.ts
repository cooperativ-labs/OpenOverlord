export function resolveAllowedBrowserOrigins({
  baseUrl,
  devPort
}: {
  baseUrl: string;
  devPort: string | undefined;
}): string[] {
  const origins = new Set<string>([baseUrl]);
  const vitePort = devPort ?? '5173';
  // Vite dev server runs on a separate port; localhost and 127.0.0.1 are distinct origins.
  origins.add(`http://localhost:${vitePort}`);
  origins.add(`http://127.0.0.1:${vitePort}`);
  // Electron desktop remote mode serves the bundled SPA from an ephemeral loopback port.
  for (let port = 4310; port <= 4360; port += 1) {
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://localhost:${port}`);
  }

  const extraOrigins = process.env.OVERLORD_WEB_ORIGINS?.trim();
  if (extraOrigins) {
    for (const origin of extraOrigins.split(',')) {
      const trimmed = origin.trim();
      if (trimmed) origins.add(trimmed);
    }
  }

  return [...origins];
}

function matchesOriginPattern(origin: string, pattern: string): boolean {
  if (!pattern.includes('*')) return origin === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(origin);
}

export function isAllowedBrowserOrigin(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.some(entry => matchesOriginPattern(origin, entry));
}

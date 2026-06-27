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
  return [...origins];
}

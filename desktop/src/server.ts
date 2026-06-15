import { type UtilityProcess, utilityProcess } from 'electron';
import http from 'node:http';
import net from 'node:net';

import { serverBundlePath, webappDistPath } from './paths.js';

/**
 * Supervises the embedded web/REST server. The server runs in an Electron
 * `utilityProcess` — a Node.js context on Electron's own ABI — so we ship and
 * sign a single runtime (no separate Node binary) while keeping the server
 * isolated from the renderer. It is the same server bundle `ovld serve` runs.
 *
 * The DB location is intentionally left to the server's default (the per-user
 * global `~/.ovld/Overlord.sqlite`), so an `ovld` invoked from a terminal shares
 * the exact same database the window shows with no extra wiring. Set
 * OVERLORD_SQLITE_PATH in the environment to override (e.g. for an isolated
 * app-data database).
 */
let child: UtilityProcess | null = null;

export interface ServerOptions {
  host: string;
  port: number;
}

export function startServer({ host, port }: ServerOptions): void {
  if (child) return;
  const entry = serverBundlePath();

  child = utilityProcess.fork(entry, [], {
    serviceName: 'overlord-server',
    stdio: 'pipe',
    env: {
      ...process.env,
      OVERLORD_WEB_HOST: host,
      OVERLORD_WEB_PORT: String(port),
      OVERLORD_WEBAPP_DIST: webappDistPath(),
      // The desktop never auto-launches the optional SQL Studio process.
      OVERLORD_SQL_STUDIO_ENABLED: 'false'
    }
  });

  child.stdout?.on('data', chunk => process.stdout.write(`[server] ${chunk}`));
  child.stderr?.on('data', chunk => process.stderr.write(`[server] ${chunk}`));
  child.on('exit', code => {
    process.stderr.write(`[server] exited with code ${code}\n`);
    child = null;
  });
}

export function stopServer(): void {
  if (!child) return;
  child.kill();
  child = null;
}

/** Poll `GET /api/health` until the server answers `{ ok: true }` or we time out. */
export async function waitForHealth({
  host,
  port,
  timeoutMs = 30_000,
  intervalMs = 300
}: {
  host: string;
  port: number;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingHealth(host, port)) return true;
    await delay(intervalMs);
  }
  return false;
}

function pingHealth(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get({ host, port, path: '/api/health', timeout: 2_000 }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 && JSON.parse(body).ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Find a free TCP port on the loopback interface, starting at `preferred`. */
export function findFreePort(preferred: number, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (candidate: number, attemptsLeft: number) => {
      const server = net.createServer();
      server.once('error', (err: NodeJS.ErrnoException) => {
        server.close();
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
          tryPort(candidate + 1, attemptsLeft - 1);
        } else {
          reject(err);
        }
      });
      server.listen(candidate, host, () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
    };
    tryPort(preferred, 20);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

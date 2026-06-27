import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';

import { webappDistPath } from './paths.js';

let child: Server | null = null;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

export interface StaticServerOptions {
  host: string;
  port: number;
}

export function startStaticServer({ host, port }: StaticServerOptions): void {
  if (child) return;

  const distDir = webappDistPath();
  if (!existsSync(distDir)) {
    throw new Error(`Bundled webapp dist not found at ${distDir}`);
  }

  child = createServer((req, res) => {
    void serveStaticRequest({ req, res, distDir });
  });
  child.listen(port, host);
}

export function stopStaticServer(): void {
  if (child) {
    child.close();
    child = null;
  }
}

async function serveStaticRequest({
  req,
  res,
  distDir
}: {
  req: IncomingMessage;
  res: ServerResponse;
  distDir: string;
}): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const relativePath = pathname === '/' ? '/index.html' : pathname;
    const candidate = path.resolve(distDir, `.${relativePath}`);
    const distRoot = path.resolve(distDir);

    if (!candidate.startsWith(distRoot)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    let filePath = candidate;
    if (!existsSync(filePath) && !path.extname(relativePath)) {
      filePath = path.join(distRoot, 'index.html');
    }

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const body = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
    res.end(body);
  } catch (error) {
    res.writeHead(500);
    res.end(error instanceof Error ? error.message : 'Internal error');
  }
}

import { type Permission, PERMISSIONS } from '@overlord/auth';
import express, { type NextFunction, type Request, type Response } from 'express';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-everhour-routes-'));
const { bootstrapIntegrationTestDb } = await import('../../test-helpers.ts');
await bootstrapIntegrationTestDb({ sqlitePath: path.join(tempDir, 'everhour-routes.sqlite') });

const { setActiveTokenAuth, setActiveWorkspaceUser } = await import('../../db.ts');
const { ApiError } = await import('../../errors.ts');
const { requirePermission } = await import('../../rbac.ts');
const { createMission, createProject } = await import('../../repository.ts');
const { createEverhourExtensionRouter } = await import('./routes.ts');

const operatorWorkspaceUserId = (await import('../../db.ts')).getActorWorkspaceUserId();

function makeHandle() {
  return (
    fn: (req: Request, res: Response) => unknown,
    options: { mutates?: boolean; requires?: Permission } = {}
  ) => {
    return (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          if (options.requires) await requirePermission(options.requires);
          const result = await Promise.resolve(fn(req, res));
          if (!res.headersSent) res.json(result ?? { ok: true });
        } catch (err) {
          next(err);
        }
      })();
    };
  };
}

async function withEverhourServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/ext/everhour', createEverhourExtensionRouter(makeHandle()));
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ message: err.message });
      return;
    }
    next(err);
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  }
}

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('GET /ext/everhour/integration requires workspace:read', async () => {
  setActiveTokenAuth({
    workspaceUserId: operatorWorkspaceUserId,
    tokenId: 'tok-read-test',
    scopeGrants: ['project:read', 'mission:read']
  });

  await withEverhourServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/ext/everhour/integration`);
    assert.equal(response.status, 403);
  });
});

test('GET /ext/everhour/integration succeeds for a full-scope operator', async () => {
  setActiveWorkspaceUser(operatorWorkspaceUserId);

  await withEverhourServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/ext/everhour/integration`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { connected: boolean };
    assert.equal(body.connected, false);
  });
});

test('PUT /ext/everhour/integration requires workspace:update', async () => {
  setActiveTokenAuth({
    workspaceUserId: operatorWorkspaceUserId,
    tokenId: 'tok-update-test',
    scopeGrants: ['workspace:read']
  });

  await withEverhourServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/ext/everhour/integration`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'secret' })
    });
    assert.equal(response.status, 403);
  });
});

test('GET /ext/everhour/projects/:projectId/link requires project:read', async () => {
  setActiveWorkspaceUser(operatorWorkspaceUserId);
  const project = await createProject({ name: 'Route Permission Project' });

  setActiveTokenAuth({
    workspaceUserId: operatorWorkspaceUserId,
    tokenId: 'tok-project-read-test',
    scopeGrants: ['workspace:read', 'mission:read']
  });

  await withEverhourServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/ext/everhour/projects/${project.id}/link`);
    assert.equal(response.status, 403);
  });
});

test('GET /ext/everhour/missions/:missionId requires mission:read', async () => {
  setActiveWorkspaceUser(operatorWorkspaceUserId);
  const project = await createProject({ name: 'Mission Route Project' });
  const mission = await createMission({ projectId: project.id, firstObjective: 'Read state' });

  setActiveTokenAuth({
    workspaceUserId: operatorWorkspaceUserId,
    tokenId: 'tok-mission-read-test',
    scopeGrants: ['workspace:read', 'project:read']
  });

  await withEverhourServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/ext/everhour/missions/${mission.id}`);
    assert.equal(response.status, 403);
  });
});

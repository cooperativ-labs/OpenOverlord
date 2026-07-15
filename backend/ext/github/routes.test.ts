import { type Permission } from '@overlord/auth';
import express, { type NextFunction, type Request, type Response } from 'express';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-github-routes-'));
const { bootstrapIntegrationTestDb, DEFAULT_TEST_ORGANIZATION_ID } =
  await import('../../test-helpers.ts');
const { WORKSPACE } = await bootstrapIntegrationTestDb({
  sqlitePath: path.join(tempDir, 'github-routes.sqlite')
});

const workspaceAId = WORKSPACE.id;
const {
  getActiveWorkspaceId,
  getActorWorkspaceUserId,
  requireDatabaseClient,
  setActiveWorkspace,
  setActiveWorkspaceUser
} = await import('../../db.ts');
const { ApiError } = await import('../../errors.ts');
const { requirePermission } = await import('../../rbac.ts');
const { createProject } = await import('../../repository.ts');
const { createWorkspace } = await import('../../workspaces.ts');
const { createGitHubExtensionRouter } = await import('./routes.ts');

const workspaceAActorId = getActorWorkspaceUserId();

function makeHandle() {
  return (
    fn: (req: Request, res: Response) => unknown,
    options: { mutates?: boolean; requires?: Permission } = {}
  ) => {
    return (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          if (options.requires) {
            await requirePermission(options.requires, {
              workspaceId: getActiveWorkspaceId(),
              workspaceUserId: getActorWorkspaceUserId()
            });
          }
          const result = await Promise.resolve(fn(req, res));
          if (!res.headersSent) res.json(result ?? { ok: true });
        } catch (error) {
          next(error);
        }
      })();
    };
  };
}

async function withGitHubServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/ext/github', createGitHubExtensionRouter(makeHandle()));
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ message: error.message });
      return;
    }
    next(error);
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  }
}

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('project routes authorize against the resource workspace, not the active workspace', async () => {
  setActiveWorkspaceUser(workspaceAActorId);
  const secondary = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'GitHub Route Secondary Workspace'
  });
  const project = await createProject({
    name: 'GitHub Route Secondary Project',
    workspaceId: secondary.id
  });

  const client = requireDatabaseClient();
  const workspaceBActor = await client.get<{ id: string }>(
    `SELECT id FROM workspace_users
      WHERE workspace_id = ? AND profile_id = 'operator-user' AND deleted_at IS NULL`,
    [secondary.id]
  );
  assert.ok(workspaceBActor);
  await client.run(
    `UPDATE role_assignments
        SET deleted_at = ?, updated_at = ?, revision = revision + 1
      WHERE workspace_id = ? AND workspace_user_id = ? AND deleted_at IS NULL`,
    [new Date().toISOString(), new Date().toISOString(), secondary.id, workspaceBActor.id]
  );

  await setActiveWorkspace(workspaceAId);
  assert.equal(getActorWorkspaceUserId(), workspaceAActorId);

  await withGitHubServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/ext/github/projects/${project.id}/link`);
    assert.equal(response.status, 403);
  });
});

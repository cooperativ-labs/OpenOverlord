import { PERMISSIONS } from '@overlord/auth';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-storage-'));
const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
const harness = await bootstrapIntegrationTestDb({
  sqlitePath: path.join(tempDir, 'webapp.sqlite')
});

const { db, setActiveTokenAuth, setActiveWorkspace, setActiveWorkspaceUser, WORKSPACE } =
  await import('./db.ts');
const { ApiError } = await import('./errors.ts');
const { requirePermission } = await import('./rbac.ts');
const { createMission, createProject } = await import('./repository.ts');
const {
  deleteObjectiveAttachment,
  resolveStoredObject,
  uploadObjectiveAttachment,
  uploadWorkspaceImage
} = await import('./storage.ts');
const { createWorkspace } = await import('./workspaces.ts');

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('s3 attachment uploads record metadata, reads are gated, and tombstones delete bytes', async () => {
  const objects = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    void (async () => {
      const key = req.url?.split('?')[0] ?? '/';
      if (req.method === 'PUT') {
        objects.set(key, await readRequestBody(req));
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.method === 'GET') {
        const body = objects.get(key);
        res.statusCode = body ? 200 : 404;
        res.end(body);
        return;
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 405;
      res.end();
    })().catch(error => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const previousAccessKeyId = process.env.S3_ACCESS_KEY_ID;
  const previousSecretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  process.env.S3_ACCESS_KEY_ID = 'test-access-key';
  process.env.S3_SECRET_ACCESS_KEY = 'test-secret-key';

  try {
    db.prepare(
      `UPDATE storage_buckets
          SET storage_backend = 's3', local_path = NULL, settings_json = ?
        WHERE workspace_id = ? AND bucket_key = 'attachments'`
    ).run(
      JSON.stringify({
        bucketName: 'overlord-storage',
        endpoint: `http://127.0.0.1:${address.port}`,
        region: 'us-east-1',
        pathPrefix: 'hosted/attachments',
        presignReads: true,
        presignTtlSeconds: 120
      }),
      WORKSPACE.id
    );

    const project = await createProject({ name: 'S3 Attachments' });
    const mission = await createMission({
      projectId: project.id,
      firstObjective: 'Upload attachment'
    });
    const objective = mission.objectives[0]!;

    const attachment = await uploadObjectiveAttachment({
      objectiveId: objective.id,
      bytes: Buffer.from('attachment-bytes'),
      filename: 'notes.txt',
      contentType: 'text/plain'
    });

    assert.equal(attachment.filename, 'notes.txt');
    assert.equal(attachment.contentType, 'text/plain');
    assert.equal(attachment.sizeBytes, 'attachment-bytes'.length);
    assert.equal(attachment.uploadStatus, 'available');
    const storedPath = `/overlord-storage/hosted/attachments/${attachment.storageKey}`;
    assert.deepEqual(objects.get(storedPath), Buffer.from('attachment-bytes'));

    await assert.rejects(
      async () => await resolveStoredObject('attachments', 'missing.txt'),
      (error: unknown) => error instanceof ApiError && error.status === 404
    );

    setActiveTokenAuth({
      workspaceUserId: harness.operatorWorkspaceUserId,
      tokenId: 'attachment-only-token',
      scopeGrants: ['attachment:read']
    });
    await assert.rejects(
      async () => await requirePermission(PERMISSIONS.PROJECT_READ),
      (error: unknown) => error instanceof ApiError && error.status === 403
    );

    setActiveWorkspaceUser(harness.operatorWorkspaceUserId);
    await requirePermission(PERMISSIONS.PROJECT_READ);
    const resolved = await resolveStoredObject('attachments', attachment.storageKey);
    assert.equal(resolved.bodyStream, undefined);
    assert.match(resolved.presignedRedirectUrl ?? '', /X-Amz-Expires=120/);
    assert.match(resolved.presignedRedirectUrl ?? '', /\/overlord-storage\/hosted\/attachments\//);

    await deleteObjectiveAttachment(objective.id, attachment.id);
    assert.equal(objects.has(storedPath), false);
  } finally {
    if (previousAccessKeyId === undefined) delete process.env.S3_ACCESS_KEY_ID;
    else process.env.S3_ACCESS_KEY_ID = previousAccessKeyId;
    if (previousSecretAccessKey === undefined) delete process.env.S3_SECRET_ACCESS_KEY;
    else process.env.S3_SECRET_ACCESS_KEY = previousSecretAccessKey;
    setActiveWorkspaceUser(harness.operatorWorkspaceUserId);
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  }
});

test('uploadWorkspaceImage stores the logo under a folder keyed by workspace ID, is admin-gated, and is servable back', async () => {
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );

  try {
    const workspace = await createWorkspace({ name: 'Storage Test Workspace' });

    const stored = await uploadWorkspaceImage({
      bytes: pngBytes,
      filename: 'logo.png',
      contentType: 'image/png'
    });

    assert.equal(stored.bucketKey, 'workspace-images');
    assert.equal(stored.contentType, 'image/png');
    assert.equal(stored.url, `/api/storage/workspace-images/${stored.storageKey}`);

    // The bucket row provisioned for this workspace roots bytes in a folder
    // keyed by its own workspace ID, with an `images` subfolder inside.
    const bucketRow = db
      .prepare(
        `SELECT local_path FROM storage_buckets
           WHERE workspace_id = ? AND bucket_key = 'workspace-images' AND deleted_at IS NULL`
      )
      .get(workspace.id) as { local_path: string };
    assert.equal(
      bucketRow.local_path,
      `database/.local/storage/workspace-images/${workspace.id}/images`
    );

    const resolved = await resolveStoredObject('workspace-images', stored.storageKey);
    assert.ok(resolved.absolutePath?.endsWith(`${workspace.id}/images/${stored.storageKey}`));

    // A member without the workspace_image:create grant cannot upload a logo.
    setActiveTokenAuth({
      workspaceUserId: harness.operatorWorkspaceUserId,
      tokenId: 'workspace-image-read-only-token',
      scopeGrants: ['workspace_image:read']
    });
    await assert.rejects(
      async () => await requirePermission(PERMISSIONS.WORKSPACE_IMAGE_CREATE),
      (error: unknown) => error instanceof ApiError && error.status === 403
    );
  } finally {
    setActiveTokenAuth({
      workspaceUserId: harness.operatorWorkspaceUserId,
      tokenId: null,
      scopeGrants: null
    });
    setActiveWorkspaceUser(harness.operatorWorkspaceUserId);
  }
});

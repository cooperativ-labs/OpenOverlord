import { PERMISSIONS } from '@overlord/auth';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-storage-'));
const { bootstrapIntegrationTestDb, DEFAULT_TEST_ORGANIZATION_ID } =
  await import('./test-helpers.ts');
const harness = await bootstrapIntegrationTestDb({
  sqlitePath: path.join(tempDir, 'webapp.sqlite')
});

const {
  db,
  getActiveWorkspaceId,
  getActorWorkspaceUserId,
  setActiveTokenAuth,
  setActiveWorkspace,
  setActiveWorkspaceUser,
  WORKSPACE
} = await import('./db.ts');
const { ApiError } = await import('./errors.ts');
const { requirePermission } = await import('./rbac.ts');
const { createMission, createProject } = await import('./repository.ts');
const {
  deleteObjectiveAttachment,
  resolveStoredObject,
  uploadObjectiveAttachment,
  uploadUserImage,
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
        pathPrefix: 'hosted',
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
    assert.match(
      attachment.storageKey,
      new RegExp(`^workspace-files/${WORKSPACE.id}/attachments/[a-z0-9-]+\\.txt$`)
    );
    const storedPath = `/overlord-storage/hosted/${attachment.storageKey}`;
    assert.deepEqual(objects.get(storedPath), Buffer.from('attachment-bytes'));

    await assert.rejects(
      async () =>
        await resolveStoredObject('attachments', 'missing.txt', PERMISSIONS.ATTACHMENT_READ),
      (error: unknown) => error instanceof ApiError && error.status === 404
    );

    setActiveTokenAuth({
      workspaceUserId: harness.operatorWorkspaceUserId,
      tokenId: 'attachment-only-token',
      scopeGrants: ['attachment:read']
    });
    await assert.rejects(
      async () =>
        await requirePermission(PERMISSIONS.PROJECT_READ, {
          workspaceId: getActiveWorkspaceId(),
          workspaceUserId: getActorWorkspaceUserId()
        }),
      (error: unknown) => error instanceof ApiError && error.status === 403
    );

    setActiveWorkspaceUser(harness.operatorWorkspaceUserId);
    await requirePermission(PERMISSIONS.PROJECT_READ, {
      workspaceId: getActiveWorkspaceId(),
      workspaceUserId: getActorWorkspaceUserId()
    });
    const resolved = await resolveStoredObject(
      'attachments',
      attachment.storageKey,
      PERMISSIONS.ATTACHMENT_READ
    );
    assert.equal(resolved.bodyStream, undefined);
    assert.match(resolved.presignedRedirectUrl ?? '', /X-Amz-Expires=120/);
    assert.match(
      resolved.presignedRedirectUrl ?? '',
      /\/overlord-storage\/hosted\/workspace-files\/local-workspace\/attachments\//
    );

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

test('uploadWorkspaceImage stores the logo under workspace-files, is admin-gated, and is servable back', async () => {
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );

  try {
    const workspace = await createWorkspace({
      organizationId: DEFAULT_TEST_ORGANIZATION_ID,
      name: 'Storage Test Workspace'
    });

    const stored = await uploadWorkspaceImage({
      bytes: pngBytes,
      filename: 'logo.png',
      contentType: 'image/png'
    });

    assert.equal(stored.bucketKey, 'workspace-images');
    assert.equal(stored.contentType, 'image/png');
    assert.match(
      stored.storageKey,
      new RegExp(`^workspace-files/${workspace.id}/images/[a-z0-9-]+\\.png$`)
    );
    assert.equal(
      stored.url,
      `/api/storage/workspace-images/${encodeURIComponent(stored.storageKey)}`
    );

    // The bucket row provisioned for this workspace roots bytes at the shared
    // storage directory; storage keys carry the workspace-files path.
    const bucketRow = db
      .prepare(
        `SELECT local_path FROM storage_buckets
           WHERE workspace_id = ? AND bucket_key = 'workspace-images' AND deleted_at IS NULL`
      )
      .get(workspace.id) as { local_path: string };
    assert.equal(bucketRow.local_path, 'database/.local/storage');

    const resolved = await resolveStoredObject(
      'workspace-images',
      stored.storageKey,
      PERMISSIONS.WORKSPACE_IMAGE_READ
    );
    assert.ok(
      resolved.absolutePath?.endsWith(
        `workspace-files/${workspace.id}/images/${path.basename(stored.storageKey)}`
      )
    );

    // A member without the workspace_image:create grant cannot upload a logo.
    setActiveTokenAuth({
      workspaceUserId: harness.operatorWorkspaceUserId,
      tokenId: 'workspace-image-read-only-token',
      scopeGrants: ['workspace_image:read']
    });
    await assert.rejects(
      async () =>
        await requirePermission(PERMISSIONS.WORKSPACE_IMAGE_CREATE, {
          workspaceId: getActiveWorkspaceId(),
          workspaceUserId: getActorWorkspaceUserId()
        }),
      (error: unknown) => error instanceof ApiError && error.status === 403
    );
  } finally {
    await setActiveWorkspace('local-workspace');
    setActiveTokenAuth({
      workspaceUserId: harness.operatorWorkspaceUserId,
      tokenId: null,
      scopeGrants: null
    });
    setActiveWorkspaceUser(harness.operatorWorkspaceUserId);
  }
});

test('uploadUserImage stores profile images under the user-images profile prefix', async () => {
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );

  const stored = await uploadUserImage({
    bytes: pngBytes,
    filename: 'avatar.png',
    contentType: 'image/png'
  });

  assert.equal(stored.bucketKey, 'user-images');
  assert.match(stored.storageKey, /^user-images\/operator-user\/[a-z0-9-]+\.png$/);
  assert.equal(stored.url, `/api/storage/user-images/${encodeURIComponent(stored.storageKey)}`);
});

test('resolveStoredObject serves legacy one-segment user image URLs by canonical basename', async () => {
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );

  const stored = await uploadUserImage({
    bytes: pngBytes,
    filename: 'avatar.png',
    contentType: 'image/png'
  });
  const legacyStorageKey = path.basename(stored.storageKey);

  const resolved = await resolveStoredObject(
    'user-images',
    legacyStorageKey,
    PERMISSIONS.USER_IMAGE_READ
  );

  assert.equal(resolved.contentType, 'image/png');
  assert.equal(resolved.filename, 'avatar.png');
  assert.ok(resolved.absolutePath?.endsWith(stored.storageKey));
});

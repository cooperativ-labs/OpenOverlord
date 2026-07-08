import { createSqliteClient, openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.js';
import { createExecutionRequest } from './execution-requests.js';
import { ensureCallerDeviceTarget } from './execution-targets.js';
import { createMissionWithObjectives, insertObjective } from './missions.js';
import {
  addProjectResource,
  assertObjectiveResourceConnected,
  createProject,
  resolveObjectiveWorkingDirectory
} from './projects.js';

describe('objective resource binding', () => {
  it('resolves an objective-bound resource key before the project primary', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'cli' });
    const project = await createProject({ ctx, name: 'Cross-repo project' });
    const localTarget = await ensureCallerDeviceTarget({ ctx });

    await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: '/tmp/openoverlord-primary',
      resourceKey: 'openoverlord',
      isPrimary: true
    });
    await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: '/tmp/overlord-mobile',
      resourceKey: 'mobile',
      isPrimary: false
    });

    const { mission, objectives } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Work in mobile repo', resourceKey: 'mobile' }]
    });

    const resolved = await resolveObjectiveWorkingDirectory({
      ctx,
      projectId: project.id,
      objectiveResourceKey: objectives[0]?.resourceKey,
      executionTargetId: localTarget.executionTargetId
    });

    assert.equal(resolved.workingDirectory, '/tmp/overlord-mobile');
    assert.notEqual(resolved.resourceId, null);

    const request = await createExecutionRequest({
      ctx,
      missionId: mission.id,
      objectiveId: objectives[0]?.id,
      requestedAgent: 'codex',
      requestedSource: 'cli',
      executionTargetId: localTarget.executionTargetId
    });
    assert.equal(request.resolvedWorkingDirectory, '/tmp/overlord-mobile');

    await db.close();
  });

  it('fails with objective_resource_not_connected when the bound key is missing on the target', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'cli' });
    const project = await createProject({ ctx, name: 'Missing objective resource' });
    const localTarget = await ensureCallerDeviceTarget({ ctx });

    await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: '/tmp/openoverlord-primary',
      resourceKey: 'openoverlord',
      isPrimary: true
    });

    const { mission, objectives } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Needs mobile checkout', resourceKey: 'mobile' }]
    });

    await assert.rejects(
      () =>
        assertObjectiveResourceConnected({
          ctx,
          projectId: project.id,
          resourceKey: 'mobile',
          executionTargetId: localTarget.executionTargetId
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'objective_resource_not_connected'
    );

    await assert.rejects(
      () =>
        createExecutionRequest({
          ctx,
          missionId: mission.id,
          objectiveId: objectives[0]?.id,
          requestedAgent: 'codex',
          requestedSource: 'cli',
          executionTargetId: localTarget.executionTargetId
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'objective_resource_not_connected'
    );

    await db.close();
  });

  it('rejects unknown resource keys when creating objectives', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'cli' });
    const project = await createProject({ ctx, name: 'Unknown key validation' });
    const { mission } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Primary objective' }]
    });

    await assert.rejects(
      () =>
        insertObjective({
          ctx,
          missionId: mission.id,
          instructionText: 'Bound to missing key',
          resourceKey: 'missing-key',
          state: 'future'
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'project_resource_key_not_found'
    );

    await db.close();
  });
});

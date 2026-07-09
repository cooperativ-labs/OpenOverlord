import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { canonicalMissionBranch, previewMissionBranch } from '../../../cli/src/branch-planning.ts';

import type { ServiceContext } from './context.js';
import { createExecutionRequest } from './execution-requests.js';
import { ensureCallerDeviceTarget } from './execution-targets.js';
import { recordMissionBranchObservations } from './mission-branch-observations.js';
import { createMissionWithObjectives } from './missions.js';
import { buildProjectResourceManifest } from './project-resource-manifest.js';
import { addProjectResource, createProject, resolveObjectiveWorkingDirectory } from './projects.js';
import { attachSession, deliverSession, loadMissionContext, updateSession } from './protocol.js';
import { recordTargetResourceObservations } from './target-resource-observations.js';
import { createSeededServiceContext } from './test-helpers.js';

const WORKTREE_ROOT = '/tmp/ovld-worktrees';
const OPENOVERLORD_DIR = '/tmp/overlord-checkout';
const MOBILE_DIR = '/tmp/overlord-mobile-checkout';

async function seedCrossRepoProject({
  ctx,
  executionTargetId
}: {
  ctx: ServiceContext;
  executionTargetId: string;
}) {
  const project = await createProject({ ctx, name: 'OpenOverlord + Mobile', slug: 'coo' });
  const overlord = await addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: OPENOVERLORD_DIR,
    resourceKey: 'overlord',
    isPrimary: true
  });
  const mobile = await addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: MOBILE_DIR,
    resourceKey: 'mobile',
    isPrimary: false
  });

  const observedAt = new Date().toISOString();
  await recordTargetResourceObservations({
    ctx,
    executionTargetId,
    observations: [
      { resourceId: overlord.id, state: 'available', observedAt },
      { resourceId: mobile.id, state: 'available', observedAt }
    ]
  });

  return { project, overlord, mobile };
}

describe('resource binding end-to-end (simulated cross-repo mission)', () => {
  it('resolves distinct worktrees, sibling manifests, and resource-scoped changed files across two objectives', async () => {
    const { db, ctx } = await createSeededServiceContext();
    const target = await ensureCallerDeviceTarget({ ctx });
    const { project, overlord, mobile } = await seedCrossRepoProject({
      ctx,
      executionTargetId: target.executionTargetId
    });

    const { mission, objectives } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      title: 'Cross-repo resource binding verification',
      objectives: [
        { objective: 'Change OpenOverlord backend', resourceKey: 'overlord' },
        { objective: 'Change OverlordMobile app', resourceKey: 'mobile' }
      ]
    });

    const missionRow = (await db.get(`SELECT sequence_number, title FROM missions WHERE id = ?`, [
      mission.id
    ])) as { sequence_number: number; title: string };
    const branchLeaf = canonicalMissionBranch({
      title: missionRow.title,
      sequence: missionRow.sequence_number
    });

    const expectedOpenWorktree = previewMissionBranch({
      mission: { title: missionRow.title, sequence: missionRow.sequence_number },
      project: { slug: 'coo' },
      resourceKey: 'overlord',
      base: 'main',
      worktreeRoot: WORKTREE_ROOT
    }).worktreePath;
    const expectedMobileWorktree = previewMissionBranch({
      mission: { title: missionRow.title, sequence: missionRow.sequence_number },
      project: { slug: 'coo' },
      resourceKey: 'mobile',
      base: 'main',
      worktreeRoot: WORKTREE_ROOT
    }).worktreePath;

    assert.notEqual(expectedOpenWorktree, expectedMobileWorktree);
    assert.equal(expectedOpenWorktree, path.join(WORKTREE_ROOT, 'coo', 'overlord', branchLeaf));
    assert.equal(expectedMobileWorktree, path.join(WORKTREE_ROOT, 'coo', 'mobile', branchLeaf));

    for (const [index, objective] of objectives.entries()) {
      const resourceKey = index === 0 ? 'overlord' : 'mobile';
      const resourceId = index === 0 ? overlord.id : mobile.id;
      const workingDirectory = index === 0 ? OPENOVERLORD_DIR : MOBILE_DIR;
      const expectedWorktree = index === 0 ? expectedOpenWorktree : expectedMobileWorktree;

      await db.run(`UPDATE objectives SET state = 'submitted' WHERE id = ?`, [objective.id]);

      const resolved = await resolveObjectiveWorkingDirectory({
        ctx,
        projectId: project.id,
        objectiveResourceKey: resourceKey,
        executionTargetId: target.executionTargetId
      });
      assert.equal(resolved.workingDirectory, workingDirectory);
      assert.equal(resolved.resourceId, resourceId);

      const request = await createExecutionRequest({
        ctx,
        missionId: mission.id,
        objectiveId: objective.id,
        requestedAgent: 'codex',
        requestedSource: 'cli',
        executionTargetId: target.executionTargetId
      });
      assert.equal(request.resolvedWorkingDirectory, workingDirectory);

      // createExecutionRequest stores resolved_resource_id on insert — read it back.
      const requestRow = (await db.get(
        `SELECT resolved_resource_id FROM execution_requests WHERE id = ?`,
        [request.id]
      )) as { resolved_resource_id: string | null };
      assert.equal(requestRow.resolved_resource_id, resourceId);

      await db.run(
        `UPDATE execution_requests SET status = 'launching', claimed_by_execution_target_id = ? WHERE id = ?`,
        [target.executionTargetId, request.id]
      );

      await recordMissionBranchObservations({
        ctx,
        executionTargetId: target.executionTargetId,
        observations: [
          {
            missionId: mission.id,
            resourceKey,
            status: 'created',
            dirty: false,
            worktreePath: expectedWorktree,
            observedAt: new Date().toISOString()
          }
        ]
      });

      const context = await loadMissionContext({
        ctx,
        missionId: mission.id,
        executionTargetId: target.executionTargetId
      });
      assert.ok(context.projectResources);
      assert.equal(context.projectResources.length, 2);
      assert.match(context.agentInstructions, /## Project Resources/);
      const current = context.projectResources.find(entry => entry.isCurrent);
      assert.equal(current?.resourceKey, resourceKey);
      assert.equal(current?.path, workingDirectory);
      const sibling = context.projectResources.find(entry => !entry.isCurrent);
      assert.ok(sibling);
      assert.notEqual(sibling?.path, workingDirectory);

      const manifest = await buildProjectResourceManifest({
        ctx,
        projectId: project.id,
        executionTargetId: target.executionTargetId,
        currentResourceKey: resourceKey
      });
      assert.equal(manifest.filter(entry => entry.isCurrent).length, 1);
      assert.equal(manifest.find(entry => entry.isCurrent)?.resourceKey, resourceKey);

      const attached = await attachSession({
        ctx,
        missionId: mission.id,
        agentIdentifier: 'e2e-test',
        executionRequestId: request.id,
        executionTargetId: target.executionTargetId
      });
      assert.equal(attached.objective.id, objective.id);

      await updateSession({
        ctx,
        missionId: mission.displayId,
        sessionKey: attached.sessionKey,
        summary: `Recorded change in ${resourceKey}`,
        changedFiles: [{ filePath: `src/e2e-${resourceKey}.ts`, vcsStatus: 'modified' }]
      });

      const changedFile = (await db.get(
        `SELECT resource_id, file_path FROM changed_files
           WHERE session_id = ? AND deleted_at IS NULL`,
        [attached.session.id]
      )) as { resource_id: string | null; file_path: string };
      assert.equal(changedFile.resource_id, resourceId);
      assert.equal(changedFile.file_path, `src/e2e-${resourceKey}.ts`);

      await deliverSession({
        ctx,
        missionId: mission.displayId,
        sessionKey: attached.sessionKey,
        summary: `Delivered ${resourceKey} objective`,
        noFileChanges: true
      });

      const objectiveRow = (await db.get(`SELECT state FROM objectives WHERE id = ?`, [
        objective.id
      ])) as { state: string };
      assert.equal(objectiveRow.state, 'complete');
    }

    await db.close();
  });
});

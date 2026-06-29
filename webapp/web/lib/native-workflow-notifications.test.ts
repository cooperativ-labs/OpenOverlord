import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EntityChangeDto } from '../../shared/contract.ts';

import { selectWorkflowNotificationCandidates } from './native-workflow-notifications.ts';

function change(overrides: Partial<EntityChangeDto> = {}): EntityChangeDto {
  return {
    seq: 1,
    entityType: 'objective',
    entityId: 'objective-1',
    operation: 'update',
    projectId: 'project-1',
    missionId: 'mission-1',
    objectiveId: 'objective-1',
    changedFields: ['state'],
    occurredAt: '2026-06-29T00:00:00.000Z',
    ...overrides
  };
}

test('classifies objective state changes as agent-start candidates', () => {
  const candidates = selectWorkflowNotificationCandidates([change()]);

  assert.deepEqual(candidates, [
    {
      kind: 'agent_started',
      missionId: 'mission-1',
      objectiveId: 'objective-1',
      entityId: 'objective-1',
      seq: 1,
      occurredAt: '2026-06-29T00:00:00.000Z'
    }
  ]);
});

test('classifies objective completion changes as ready-for-review fallback candidates', () => {
  const candidates = selectWorkflowNotificationCandidates([
    change({ changedFields: ['state', 'completed_at'] })
  ]);

  assert.deepEqual(
    candidates.map(candidate => candidate.kind),
    ['agent_started', 'ready_for_review']
  );
  assert.ok(candidates.every(candidate => candidate.entityId === 'objective-1'));
});

test('classifies durable mission events as blocking-question and delivery candidates', () => {
  const candidates = selectWorkflowNotificationCandidates([
    change({
      seq: 2,
      entityType: 'mission_event',
      entityId: 'event-1',
      objectiveId: 'objective-1',
      operation: 'insert',
      changedFields: []
    })
  ]);

  assert.deepEqual(
    candidates.map(candidate => candidate.kind),
    ['blocking_question', 'ready_for_review']
  );
  assert.ok(candidates.every(candidate => candidate.entityId === 'event-1'));
});

test('classifies execution request status plus last_error changes as launch failures', () => {
  const candidates = selectWorkflowNotificationCandidates([
    change({
      seq: 3,
      entityType: 'execution_request',
      entityId: 'request-1',
      operation: 'update',
      changedFields: ['status', 'last_error', 'launch_completed_at']
    })
  ]);

  assert.deepEqual(candidates, [
    {
      kind: 'launch_failed',
      missionId: 'mission-1',
      objectiveId: 'objective-1',
      entityId: 'request-1',
      seq: 3,
      occurredAt: '2026-06-29T00:00:00.000Z'
    }
  ]);
});

test('ignores changes without durable notification transition fields', () => {
  const candidates = selectWorkflowNotificationCandidates([
    change({ changedFields: ['title'] }),
    change({ entityType: 'execution_request', entityId: 'request-1', changedFields: ['status'] }),
    change({ missionId: null })
  ]);

  assert.deepEqual(candidates, []);
});

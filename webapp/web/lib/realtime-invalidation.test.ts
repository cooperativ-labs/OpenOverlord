import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EntityChangeDto } from '../../shared/contract.ts';

import { invalidateRealtimeChanges } from './realtime-invalidation.ts';

type InvalidationCall = readonly unknown[] | 'all';

function change(overrides: Partial<EntityChangeDto> = {}): EntityChangeDto {
  return {
    seq: 1,
    entityType: 'mission',
    entityId: 'mission-1',
    operation: 'update',
    projectId: 'project-1',
    missionId: 'mission-1',
    objectiveId: null,
    changedFields: [],
    occurredAt: '2026-06-29T00:00:00.000Z',
    ...overrides
  };
}

function fakeClient() {
  const calls: InvalidationCall[] = [];
  return {
    calls,
    client: {
      invalidateQueries(filters?: { queryKey?: readonly unknown[] }) {
        calls.push(filters?.queryKey ?? 'all');
      }
    }
  };
}

test('routes mission branch changes to mission, lists, my missions, branch, and worktrees', () => {
  const { client, calls } = fakeClient();

  const mode = invalidateRealtimeChanges(client, [
    change({ changedFields: ['active_branch', 'branch_override'] })
  ]);

  assert.equal(mode, 'targeted');
  assert.deepEqual(calls, [
    ['mission', 'mission-1'],
    ['project', 'project-1', 'missions'],
    ['workspace', 'my-missions'],
    ['mission', 'mission-1', 'branches'],
    ['worktrees']
  ]);
});

test('deduplicates workflow invalidations across objective, request, and session batches', () => {
  const { client, calls } = fakeClient();

  const mode = invalidateRealtimeChanges(client, [
    change({
      entityType: 'objective',
      entityId: 'objective-1',
      objectiveId: 'objective-1',
      changedFields: ['state']
    }),
    change({
      entityType: 'execution_request',
      entityId: 'request-1',
      objectiveId: 'objective-1',
      changedFields: ['status']
    }),
    change({
      entityType: 'agent_session',
      entityId: 'session-1',
      objectiveId: 'objective-1',
      changedFields: ['delivery_state']
    })
  ]);

  assert.equal(mode, 'targeted');
  assert.deepEqual(calls, [
    ['mission', 'mission-1'],
    ['project', 'project-1', 'missions'],
    ['workspace', 'my-missions']
  ]);
});

test('routes mission events, deliveries, and attachments to scoped queries', () => {
  const { client, calls } = fakeClient();

  const mode = invalidateRealtimeChanges(client, [
    change({
      entityType: 'mission_event',
      entityId: 'event-1',
      changedFields: []
    }),
    change({
      entityType: 'delivery',
      entityId: 'delivery-1',
      changedFields: []
    }),
    change({
      entityType: 'attachment',
      entityId: 'attachment-1',
      objectiveId: 'objective-1',
      changedFields: []
    })
  ]);

  assert.equal(mode, 'targeted');
  assert.deepEqual(calls, [
    ['mission', 'mission-1', 'events'],
    ['mission', 'mission-1', 'deliveries'],
    ['objective', 'objective-1', 'attachments']
  ]);
});

test('falls back to full invalidation for malformed or unroutable changes', () => {
  for (const changes of [
    { changes: [] },
    [change({ entityType: 'unknown_entity' })],
    [change({ missionId: null })],
    [change({ changedFields: [42] as unknown as string[] })]
  ]) {
    const { client, calls } = fakeClient();
    const mode = invalidateRealtimeChanges(client, changes);
    assert.equal(mode, 'full');
    assert.deepEqual(calls, ['all']);
  }
});

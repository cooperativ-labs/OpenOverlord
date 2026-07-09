import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProjectResourceDto } from '../../shared/contract.ts';

import {
  distinctProjectResourceKeys,
  firstObjectiveCreatePayload,
  missionDraftResourceBadgeKey,
  objectiveResourceConnection,
  resolveResourceForKey
} from './project-resources.ts';

function resource(
  partial: Partial<ProjectResourceDto> & Pick<ProjectResourceDto, 'resourceKey'>
): ProjectResourceDto {
  return {
    id: partial.id ?? 'resource-id',
    workspaceId: 'workspace-id',
    projectId: 'project-id',
    executionTargetId:
      'executionTargetId' in partial ? (partial.executionTargetId ?? null) : 'target-id',
    resourceKey: partial.resourceKey,
    type: 'local_directory',
    label: partial.label ?? partial.resourceKey,
    path: partial.path ?? `/tmp/${partial.resourceKey}`,
    isPrimary: partial.isPrimary ?? false,
    status: partial.status ?? 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1
  };
}

describe('objectiveResourceConnection', () => {
  it('uses the bound resource key when present', () => {
    const resources = [
      resource({ resourceKey: 'overlord', isPrimary: true, path: '/tmp/overlord' }),
      resource({ resourceKey: 'mobile', path: '/tmp/mobile' })
    ];

    const connection = objectiveResourceConnection({
      resources,
      resourceKey: 'mobile'
    });

    assert.equal(connection.connected, true);
    assert.equal(connection.primary?.resourceKey, 'mobile');
  });

  it('reports missing objective-bound resources', () => {
    const resources = [resource({ resourceKey: 'overlord', isPrimary: true })];

    const connection = objectiveResourceConnection({
      resources,
      resourceKey: 'mobile'
    });

    assert.equal(connection.connected, false);
    assert.match(connection.message ?? '', /mobile/);
  });
});

describe('distinctProjectResourceKeys', () => {
  it('returns unique active resource keys', () => {
    const keys = distinctProjectResourceKeys([
      resource({ resourceKey: 'mobile' }),
      resource({ resourceKey: 'overlord', isPrimary: true }),
      resource({ resourceKey: 'mobile', executionTargetId: 'other-target' }),
      resource({ resourceKey: 'archived', status: 'archived' })
    ]);

    assert.deepEqual(keys, ['mobile', 'overlord']);
  });
});

describe('resolveResourceForKey', () => {
  it('selects the resource matching the bound key', () => {
    const resources = [
      resource({ id: 'oo', resourceKey: 'overlord', isPrimary: true, path: '/tmp/oo' }),
      resource({ id: 'mob', resourceKey: 'mobile', path: '/tmp/mob' })
    ];

    const resolved = resolveResourceForKey({
      resources,
      executionTargetId: 'target-id',
      resourceKey: 'mobile'
    });

    assert.equal(resolved?.id, 'mob');
  });

  it('falls back to the primary when the bound key is not linked', () => {
    const resources = [
      resource({ id: 'oo', resourceKey: 'overlord', isPrimary: true, path: '/tmp/oo' })
    ];

    const resolved = resolveResourceForKey({
      resources,
      executionTargetId: 'target-id',
      resourceKey: 'mobile'
    });

    assert.equal(resolved?.id, 'oo');
  });

  it('resolves the primary resource when no key is given', () => {
    const resources = [
      resource({ id: 'mob', resourceKey: 'mobile', path: '/tmp/mob' }),
      resource({ id: 'oo', resourceKey: 'overlord', isPrimary: true, path: '/tmp/oo' })
    ];

    const resolved = resolveResourceForKey({ resources, executionTargetId: null });

    assert.equal(resolved?.id, 'oo');
  });

  it('prefers a target-scoped match for the bound key', () => {
    const resources = [
      resource({ id: 'mob-a', resourceKey: 'mobile', executionTargetId: null, path: '/tmp/a' }),
      resource({
        id: 'mob-b',
        resourceKey: 'mobile',
        executionTargetId: 'target-id',
        path: '/tmp/b'
      })
    ];

    const resolved = resolveResourceForKey({
      resources,
      executionTargetId: 'target-id',
      resourceKey: 'mobile'
    });

    assert.equal(resolved?.id, 'mob-b');
  });
});

describe('firstObjectiveCreatePayload', () => {
  it('binds the resource key when one is chosen', () => {
    assert.deepEqual(firstObjectiveCreatePayload('Do the thing', 'mobile'), {
      objectives: [{ objective: 'Do the thing', resourceKey: 'mobile' }]
    });
  });

  it('uses the simple first objective shape when unbound', () => {
    assert.deepEqual(firstObjectiveCreatePayload('Do the thing', null), {
      firstObjective: 'Do the thing'
    });
    assert.deepEqual(firstObjectiveCreatePayload('Do the thing', '  '), {
      firstObjective: 'Do the thing'
    });
    assert.deepEqual(firstObjectiveCreatePayload('Do the thing'), {
      firstObjective: 'Do the thing'
    });
  });
});

describe('missionDraftResourceBadgeKey', () => {
  it('returns null for single-resource projects', () => {
    const resources = [resource({ resourceKey: 'overlord', isPrimary: true })];

    assert.equal(
      missionDraftResourceBadgeKey({ resources, draftObjectiveResourceKey: 'mobile' }),
      null
    );
  });

  it('uses the draft objective key when set', () => {
    const resources = [
      resource({ resourceKey: 'overlord', isPrimary: true }),
      resource({ resourceKey: 'mobile' })
    ];

    assert.equal(
      missionDraftResourceBadgeKey({ resources, draftObjectiveResourceKey: 'mobile' }),
      'mobile'
    );
  });

  it('falls back to the primary resource when the draft inherits it', () => {
    const resources = [
      resource({ resourceKey: 'overlord', isPrimary: true }),
      resource({ resourceKey: 'mobile' })
    ];

    assert.equal(
      missionDraftResourceBadgeKey({ resources, draftObjectiveResourceKey: null }),
      'overlord'
    );
  });
});

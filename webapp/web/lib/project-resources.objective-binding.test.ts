import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProjectResourceDto } from '../../shared/contract.ts';

import { distinctProjectResourceKeys, objectiveResourceConnection } from './project-resources.ts';

function resource(
  partial: Partial<ProjectResourceDto> & Pick<ProjectResourceDto, 'resourceKey'>
): ProjectResourceDto {
  return {
    id: partial.id ?? 'resource-id',
    workspaceId: 'workspace-id',
    projectId: 'project-id',
    executionTargetId: partial.executionTargetId ?? 'target-id',
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
      resource({ resourceKey: 'openoverlord', isPrimary: true, path: '/tmp/openoverlord' }),
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
    const resources = [resource({ resourceKey: 'openoverlord', isPrimary: true })];

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
      resource({ resourceKey: 'openoverlord', isPrimary: true }),
      resource({ resourceKey: 'mobile', executionTargetId: 'other-target' }),
      resource({ resourceKey: 'archived', status: 'archived' })
    ]);

    assert.deepEqual(keys, ['mobile', 'openoverlord']);
  });
});

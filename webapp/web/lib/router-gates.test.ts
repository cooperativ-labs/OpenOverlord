import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildAddCwdCommand,
  clearOnboardingSetupPending,
  markOnboardingSetupPending
} from './onboarding-setup.ts';
import { shouldShowOnboarding, shouldShowOnboardingSetup } from './router-gates.ts';

describe('organization sidebar layout', () => {
  it('maps each accessible workspace in meta to a sidebar section id', () => {
    const workspaces = [
      { id: 'ws-1', name: 'General' },
      { id: 'ws-2', name: 'Engineering' }
    ];

    const sectionIds = workspaces.map(workspace => workspace.id);
    assert.deepEqual(sectionIds, ['ws-1', 'ws-2']);
    assert.equal(sectionIds.length, 2);
  });
});

describe('shouldShowOnboarding', () => {
  it('returns true when the user has zero organizations', () => {
    assert.equal(shouldShowOnboarding({ organizations: [] }), true);
  });

  it('returns false once the user belongs to at least one organization', () => {
    assert.equal(
      shouldShowOnboarding({
        organizations: [
          {
            id: 'org-1',
            name: 'Acme',
            logoUrl: null,
            workspaceCount: 1,
            isActive: true,
            createdAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      }),
      false
    );
  });
});

describe('buildAddCwdCommand', () => {
  it('includes the project id in the ovld add-cwd command', () => {
    assert.equal(
      buildAddCwdCommand({ projectId: 'proj-123' }),
      'ovld add-cwd --project-id proj-123'
    );
  });
});

describe('shouldShowOnboardingSetup', () => {
  const metaWithOrg = {
    organizations: [
      {
        id: 'org-1',
        name: 'Acme',
        logoUrl: null,
        workspaceCount: 1,
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z'
      }
    ]
  };

  it('returns false when desktop setup is not pending', () => {
    clearOnboardingSetupPending();
    assert.equal(shouldShowOnboardingSetup(metaWithOrg), false);
  });

  it('returns true when desktop setup is pending and the user has an organization', () => {
    markOnboardingSetupPending();
    try {
      assert.equal(shouldShowOnboardingSetup(metaWithOrg), true);
    } finally {
      clearOnboardingSetupPending();
    }
  });
});

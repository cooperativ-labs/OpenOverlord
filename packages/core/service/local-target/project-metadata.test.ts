import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { readProjectJsonLink, writeProjectJson } from './project-metadata.ts';

describe('project metadata', () => {
  it('reads legacy single-resource metadata', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ovld-project-json-legacy-'));
    const overlordDir = path.join(directory, '.overlord');
    const projectJsonPath = path.join(overlordDir, 'project.json');

    writeProjectJson({
      directoryPath: directory,
      projectId: 'project-1',
      resourceId: 'resource-1',
      isPrimary: true
    });

    const raw = JSON.parse(readFileSync(projectJsonPath, 'utf8')) as Record<string, unknown>;
    delete raw.resourceIdsByExecutionTarget;

    const contents = `${JSON.stringify(raw, null, 2)}\n`;
    // Rewrite the file without the additive field to simulate an older checkout.
    writeFileSync(projectJsonPath, contents);

    assert.deepEqual(readProjectJsonLink(projectJsonPath), {
      projectId: 'project-1',
      resourceId: 'resource-1',
      resourceIdsByExecutionTarget: {},
      isPrimary: true
    });
  });

  it('merges resource ids across execution targets and resolves the preferred target', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ovld-project-json-multi-'));
    const projectJsonPath = writeProjectJson({
      directoryPath: directory,
      projectId: 'project-1',
      resourceId: 'resource-local',
      executionTargetId: 'target-local',
      isPrimary: true
    });

    writeProjectJson({
      directoryPath: directory,
      projectId: 'project-1',
      resourceId: 'resource-remote',
      executionTargetId: 'target-remote',
      isPrimary: true
    });

    const parsed = JSON.parse(readFileSync(projectJsonPath, 'utf8')) as {
      version: number;
      resourceId: string;
      resourceIdsByExecutionTarget?: Record<string, string>;
    };
    assert.equal(parsed.version, 2);
    assert.equal(parsed.resourceId, 'resource-remote');
    assert.deepEqual(parsed.resourceIdsByExecutionTarget, {
      'target-local': 'resource-local',
      'target-remote': 'resource-remote'
    });

    assert.equal(
      readProjectJsonLink(projectJsonPath, { preferredExecutionTargetId: 'target-local' })
        ?.resourceId,
      'resource-local'
    );
    assert.equal(
      readProjectJsonLink(projectJsonPath, { preferredExecutionTargetId: 'target-remote' })
        ?.resourceId,
      'resource-remote'
    );
  });
});

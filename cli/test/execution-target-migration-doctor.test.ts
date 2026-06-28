import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExecutionTargetMigrationDoctorCheck } from '../src/execution-target-migration-doctor.ts';

test('buildExecutionTargetMigrationDoctorCheck skips loopback backends', () => {
  assert.equal(
    buildExecutionTargetMigrationDoctorCheck({
      diagnostics: {
        hostedBackend: false,
        backendHostFingerprint: 'abc',
        staleBackendHostTargets: [
          {
            executionTargetId: 'et-1',
            label: 'Railway',
            deviceLabel: 'railway',
            deviceFingerprint: 'abc'
          }
        ],
        staleQueuedExecutionRequestCount: 2
      }
    }),
    null
  );
});

test('buildExecutionTargetMigrationDoctorCheck reports ok when hosted backend is clean', () => {
  const check = buildExecutionTargetMigrationDoctorCheck({
    diagnostics: {
      hostedBackend: true,
      backendHostFingerprint: 'abc',
      staleBackendHostTargets: [],
      staleQueuedExecutionRequestCount: 0
    }
  });
  assert.ok(check);
  assert.equal(check!.ok, true);
  assert.equal(check!.name, 'execution-target-migration');
});

test('buildExecutionTargetMigrationDoctorCheck warns on stale backend-host targets', () => {
  const check = buildExecutionTargetMigrationDoctorCheck({
    diagnostics: {
      hostedBackend: true,
      backendHostFingerprint: 'abc',
      staleBackendHostTargets: [
        {
          executionTargetId: 'et-1',
          label: 'Hosted backend host',
          deviceLabel: 'railway',
          deviceFingerprint: 'abc'
        }
      ],
      staleQueuedExecutionRequestCount: 3
    }
  });
  assert.ok(check);
  assert.equal(check!.ok, false);
  assert.match(check!.detail, /1 execution target/);
  assert.match(check!.detail, /3 queued execution request/);
  assert.match(check!.detail, /upgrading-client-checkout-bridge/);
});

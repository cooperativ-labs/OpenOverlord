import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FakeLocalTargetProvider } from './fake-provider.ts';
import { InProcessProvider } from './in-process-provider.ts';
import { isOk } from './result.ts';
import { deriveResourceStatus, resolveBackendResourceProvider } from './resource-status.ts';
import type { TargetMetadata } from './types.ts';

const META: TargetMetadata = {
  executionTargetId: 't1',
  deviceLabel: null,
  transport: 'in_process'
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MISSING = path.join(HERE, 'definitely-does-not-exist-xyz');

describe('InProcessProvider.observeResource', () => {
  it('reports available for an existing path', async () => {
    const r = await new InProcessProvider(META).observeResource({ resourceId: 'r', path: HERE });
    assert.ok(isOk(r));
    assert.equal(r.value.state, 'available');
    assert.equal(r.target.transport, 'in_process');
  });

  it('reports missing for a non-existent path', async () => {
    const r = await new InProcessProvider(META).observeResource({ resourceId: 'r', path: MISSING });
    assert.ok(isOk(r));
    assert.equal(r.value.state, 'missing');
  });

  it('reports CAPABILITY_NOT_IMPLEMENTED for CLI-owned capabilities', async () => {
    const provider = new InProcessProvider(META);
    const prepare = await provider.prepareBranch({ missionId: 'm1' });
    assert.ok(!prepare.ok);
    assert.equal(prepare.code, 'CAPABILITY_NOT_IMPLEMENTED');
    const launch = await provider.launchAgent({ executionRequestId: 'req-1' });
    assert.ok(!launch.ok);
    assert.equal(launch.code, 'CAPABILITY_NOT_IMPLEMENTED');
  });

  it('runs portable doctor checks', async () => {
    const r = await new InProcessProvider(META).doctor();
    assert.ok(isOk(r));
    assert.ok(r.value.checks.length >= 2);
  });
});

describe('deriveResourceStatus', () => {
  it('returns archived for archived lifecycle without observing', async () => {
    const fake = new FakeLocalTargetProvider();
    const status = await deriveResourceStatus(fake, { resourceId: 'r', status: 'archived', path: MISSING });
    assert.equal(status, 'archived');
    assert.equal(fake.calls.length, 0, 'archived must not trigger an observation');
  });

  it('co-located: maps an existing checkout to active', async () => {
    const provider = resolveBackendResourceProvider(true, META);
    const status = await deriveResourceStatus(provider, { resourceId: 'r', status: 'active', path: HERE });
    assert.equal(status, 'active');
  });

  it('co-located: maps a missing checkout to missing', async () => {
    const provider = resolveBackendResourceProvider(true, META);
    const status = await deriveResourceStatus(provider, { resourceId: 'r', status: 'active', path: MISSING });
    assert.equal(status, 'missing');
  });

  it('not co-located: keeps recorded lifecycle and never marks missing', async () => {
    const provider = resolveBackendResourceProvider(false, META);
    // Even with a path that does not exist on this (backend) host, status stays
    // the recorded lifecycle — the hosted backend must not infer `missing`.
    const status = await deriveResourceStatus(provider, { resourceId: 'r', status: 'active', path: MISSING });
    assert.equal(status, 'active');
  });

  it('preserves lifecycle for non-available/missing observations (e.g. unreachable)', async () => {
    const fake = new FakeLocalTargetProvider({
      handlers: {
        observeResource: async () => ({
          ok: true,
          value: { state: 'unreachable', observedAt: new Date(0).toISOString() },
          target: META
        })
      }
    });
    const status = await deriveResourceStatus(fake, { resourceId: 'r', status: 'active', path: HERE });
    assert.equal(status, 'active');
  });
});

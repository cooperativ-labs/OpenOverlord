import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeLocalTargetProvider } from './fake-provider.ts';
import {
  type ExecutionTargetRef,
  LocalTargetProviderRegistry,
  targetMetadata,
  UnavailableProvider
} from './registry.ts';
import { fail, isFailure, isOk, ok } from './result.ts';
import type { TargetMetadata } from './types.ts';

const META: TargetMetadata = {
  executionTargetId: 't1',
  deviceLabel: 'Laptop',
  transport: 'in_process'
};

describe('result constructors', () => {
  it('ok() carries value and target; isOk narrows', () => {
    const r = ok(META, { written: true });
    assert.ok(isOk(r));
    assert.equal(r.value.written, true);
    assert.deepEqual(r.target, META);
  });

  it('fail() carries code/message/details; isFailure narrows', () => {
    const r = fail(META, 'GIT_COMMAND_FAILED', 'boom', { exit: 1 });
    assert.ok(isFailure(r));
    assert.equal(r.code, 'GIT_COMMAND_FAILED');
    assert.equal(r.message, 'boom');
    assert.deepEqual(r.details, { exit: 1 });
  });

  it('fail() omits details when not provided', () => {
    const r = fail(META, 'UNKNOWN', 'nope');
    assert.ok(!('details' in r));
  });
});

describe('LocalTargetProviderRegistry', () => {
  const localTarget: ExecutionTargetRef = { executionTargetId: 't1', type: 'local', reachable: true };
  const cloudTarget: ExecutionTargetRef = { executionTargetId: 't2', type: 'cloud_sandbox' };

  it('resolves the first factory that serves the target; order is priority', () => {
    const registry = new LocalTargetProviderRegistry();
    const fakeLocal = new FakeLocalTargetProvider({ target: { executionTargetId: 't1' } });
    registry.register(t => (t.type === 'local' ? fakeLocal : null));
    registry.register(() => new FakeLocalTargetProvider()); // catch-all, lower priority

    assert.equal(registry.resolve(localTarget), fakeLocal);
    // The catch-all still serves an otherwise-unmatched target.
    assert.ok(registry.resolve(cloudTarget) instanceof FakeLocalTargetProvider);
  });

  it('returns null when no factory serves the target', () => {
    const registry = new LocalTargetProviderRegistry();
    registry.register(t => (t.type === 'local' ? new FakeLocalTargetProvider() : null));
    assert.equal(registry.resolve(cloudTarget), null);
  });

  it('resolveOrUnavailable yields a LOCAL_TARGET_REQUIRED provider when none serves', async () => {
    const registry = new LocalTargetProviderRegistry();
    const provider = registry.resolveOrUnavailable(cloudTarget);
    assert.ok(provider instanceof UnavailableProvider);
    const r = await provider.listBranches({ resourceId: 'r1' });
    assert.ok(isFailure(r));
    assert.equal(r.code, 'LOCAL_TARGET_REQUIRED');
    assert.equal(r.target.executionTargetId, 't2');
    assert.equal(r.target.transport, 'fake');
  });
});

describe('targetMetadata', () => {
  it('derives metadata for a ref under a transport', () => {
    const meta = targetMetadata({ executionTargetId: 't9', type: 'local', deviceLabel: 'VM' }, 'runner_queue');
    assert.deepEqual(meta, { executionTargetId: 't9', deviceLabel: 'VM', transport: 'runner_queue' });
  });

  it('defaults a missing deviceLabel to null', () => {
    const meta = targetMetadata({ executionTargetId: null, type: 'local' }, 'in_process');
    assert.equal(meta.deviceLabel, null);
  });
});

describe('UnavailableProvider', () => {
  it('fails every capability with the configured code', async () => {
    const provider = new UnavailableProvider(META, 'LOCAL_TARGET_UNREACHABLE', 'offline');
    for (const call of [
      provider.observeResource({ resourceId: 'r', path: '/p' }),
      provider.readCurrentDiff({ missionId: 'm' }),
      provider.purgeMergedWorktrees(),
      provider.doctor()
    ]) {
      const r = await call;
      assert.ok(isFailure(r));
      assert.equal(r.code, 'LOCAL_TARGET_UNREACHABLE');
      assert.equal(r.message, 'offline');
    }
  });
});

describe('FakeLocalTargetProvider', () => {
  it('returns canned successes and records calls', async () => {
    const fake = new FakeLocalTargetProvider();
    const r = await fake.observeResource({ resourceId: 'r1', path: '/repo' });
    assert.ok(isOk(r));
    assert.equal(r.value.state, 'available');
    assert.equal(r.target.transport, 'fake');
    assert.deepEqual(fake.calls, [
      { capability: 'observeResource', args: [{ resourceId: 'r1', path: '/repo' }] }
    ]);
  });

  it('honors per-capability handler overrides (swappable in tests)', async () => {
    const fake = new FakeLocalTargetProvider({
      target: { executionTargetId: 'vm-1', deviceLabel: 'CI VM' },
      handlers: {
        observeResource: async input =>
          fail(
            { executionTargetId: 'vm-1', deviceLabel: 'CI VM', transport: 'fake' },
            'RESOURCE_MISSING',
            `no checkout at ${input.path}`
          )
      }
    });
    const r = await fake.observeResource({ resourceId: 'r1', path: '/gone' });
    assert.ok(isFailure(r));
    assert.equal(r.code, 'RESOURCE_MISSING');
    assert.equal(r.message, 'no checkout at /gone');
    // Unoverridden capabilities still use the default success.
    const branches = await fake.listBranches({ resourceId: 'r1' });
    assert.ok(isOk(branches));
    assert.deepEqual(branches.value, { local: ['main'], remote: [], current: 'main' });
  });
});

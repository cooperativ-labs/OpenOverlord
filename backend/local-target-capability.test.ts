import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  isDevInProcessLocalTargetEnabled,
  resolveLocalTargetServerCapability
} from './execution/local-target-capability.ts';

describe('local-target server capability', () => {
  const previous = process.env.OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET;
    } else {
      process.env.OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET = previous;
    }
  });

  it('reports unavailable for postgres regardless of dev flag', () => {
    process.env.OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET = 'true';
    assert.equal(resolveLocalTargetServerCapability({ dialect: 'postgres' }), 'unavailable');
  });

  it('reports unavailable for sqlite unless dev proxy is opted in', () => {
    delete process.env.OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET;
    assert.equal(resolveLocalTargetServerCapability({ dialect: 'sqlite' }), 'unavailable');
    assert.equal(isDevInProcessLocalTargetEnabled(), false);

    process.env.OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET = 'true';
    assert.equal(resolveLocalTargetServerCapability({ dialect: 'sqlite' }), 'in_process_server');
    assert.equal(isDevInProcessLocalTargetEnabled(), true);
  });
});

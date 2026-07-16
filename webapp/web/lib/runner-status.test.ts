import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasRunnerQueueError } from './runner-status.ts';

describe('hasRunnerQueueError', () => {
  it('keeps a data-less queue failure visible while React Query retries it', () => {
    assert.equal(hasRunnerQueueError({ isError: false, data: undefined, errorUpdatedAt: 1 }), true);
  });

  it('does not report an error while the first queue request is pending', () => {
    assert.equal(
      hasRunnerQueueError({ isError: false, data: undefined, errorUpdatedAt: 0 }),
      false
    );
  });

  it('clears the retained error after a successful queue response', () => {
    assert.equal(
      hasRunnerQueueError({ isError: false, data: { activeCount: 0 }, errorUpdatedAt: 1 }),
      false
    );
  });
});

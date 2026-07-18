import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasRunnerQueueError, runnerQueueErrorMessage } from './runner-status.ts';

describe('hasRunnerQueueError', () => {
  it('keeps a data-less queue failure visible while React Query retries it', () => {
    assert.equal(
      hasRunnerQueueError({
        isLoadingError: false,
        isFetching: true,
        data: undefined,
        errorUpdateCount: 1
      }),
      true
    );
  });

  it('does not report an error while the first queue request is pending', () => {
    assert.equal(
      hasRunnerQueueError({
        isLoadingError: false,
        isFetching: true,
        data: undefined,
        errorUpdateCount: 0
      }),
      false
    );
  });

  it('reports a settled loading error with no queue data', () => {
    assert.equal(
      hasRunnerQueueError({
        isLoadingError: true,
        isFetching: false,
        data: undefined,
        errorUpdateCount: 1
      }),
      true
    );
  });

  it('clears the retained error after a successful queue response', () => {
    assert.equal(
      hasRunnerQueueError({
        isLoadingError: false,
        isFetching: false,
        data: { activeCount: 0 },
        errorUpdateCount: 1
      }),
      false
    );
  });

  it('does not hide a healthy queue behind a background refetch failure', () => {
    assert.equal(
      hasRunnerQueueError({
        isLoadingError: false,
        isFetching: false,
        data: { queue: [], activeCount: 0 },
        errorUpdateCount: 2
      }),
      false
    );
  });

  it('does not stay unavailable while idle with no prior failure', () => {
    assert.equal(
      hasRunnerQueueError({
        isLoadingError: false,
        isFetching: false,
        data: undefined,
        errorUpdateCount: 0
      }),
      false
    );
  });
});

describe('runnerQueueErrorMessage', () => {
  it('returns an Error message', () => {
    assert.equal(runnerQueueErrorMessage(new Error('Authentication required')), 'Authentication required');
  });

  it('returns null for empty errors', () => {
    assert.equal(runnerQueueErrorMessage(null), null);
    assert.equal(runnerQueueErrorMessage(''), null);
  });
});

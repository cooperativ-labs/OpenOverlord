/**
 * Whether the runner queue has an unresolved fetch failure with nothing usable
 * to display.
 *
 * TanStack Query resets a data-less failed query to `pending` while it retries
 * or refetches, temporarily making `isError` / `isLoadingError` false. Keep the
 * unavailable state for that in-flight window so the sidebar does not flash
 * "Runner ready".
 *
 * Do NOT treat a background refetch failure as a queue outage when a prior
 * successful response still supplies queue data (`isRefetchError`) — the runner
 * is still observable; hide only when there is no data to show.
 */
export function hasRunnerQueueError({
  isLoadingError,
  isFetching,
  data,
  errorUpdateCount
}: {
  isLoadingError: boolean;
  isFetching: boolean;
  data: unknown;
  errorUpdateCount: number;
}): boolean {
  if (data !== undefined) return false;
  if (isLoadingError) return true;
  // Data-less retry / refetch after a prior failure — retain unavailable.
  return isFetching && errorUpdateCount > 0;
}

/** Human-readable detail for a failed runner-queue query, when available. */
export function runnerQueueErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return null;
}

/**
 * Whether the runner queue has an unresolved fetch failure.
 *
 * TanStack Query resets a data-less failed query to `pending` while it retries,
 * temporarily making `isError` false. `errorUpdatedAt` remains set until a
 * successful response supplies queue data, so retain the error display for that
 * retry window instead of falsely reporting that the runner is ready.
 */
export function hasRunnerQueueError({
  isError,
  data,
  errorUpdatedAt
}: {
  isError: boolean;
  data: unknown;
  errorUpdatedAt: number;
}): boolean {
  return isError || (data === undefined && errorUpdatedAt > 0);
}

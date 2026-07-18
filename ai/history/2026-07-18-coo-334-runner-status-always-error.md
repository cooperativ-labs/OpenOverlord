# coo:334 — Runner status always unavailable

## Finding

`GET /api/runner/status` is healthy (CLI/`USER_TOKEN` returns `{ queue: [], activeCount: 0 }`). The UI stayed on "Could not load the runner queue" / "unavailable" because of the previous sticky error predicate and hidden failure text — not because the runner queue itself was broken.

## Causes

1. **`hasRunnerQueueError` was too broad.** It used `isError || (data === undefined && errorUpdatedAt > 0)`, which:
   - Kept "unavailable" for any data-less query that had ever failed (including React Query retry/refetch resets).
   - Treated background **refetch** failures as a full queue outage even when prior successful data was still in cache.
2. **The real error was invisible.** The modal always showed a generic string and never rendered `runner.error` / `failureReason`.
3. **Shared-query thrashing.** The modal called `useRunnerStatus({ enabled: open })`, overwriting the shared React Query options to `enabled: false` whenever the modal was closed.

## Fix

- Predicate now: no usable data + (`isLoadingError` or in-flight fetch after a prior failure). Prior queue data is not hidden behind a refetch error.
- Modal/sidebar surface the concrete error message when present.
- Modal keeps the shared always-on query (only tightens `refetchInterval` while open).

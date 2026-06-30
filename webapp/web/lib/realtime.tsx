import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';

import type { EntityChangeDto, SyncChangesDto } from '../../shared/contract.ts';

import { getAuthorizationHeader } from './api-base.ts';
import { fetchApi, resolveEventSourceUrl } from './api-transport.ts';
import { connectEventStream } from './fetch-sse.ts';
import { invalidateRealtimeChanges } from './realtime-invalidation.ts';

export type LinkState = 'connecting' | 'live' | 'reconnecting';

interface RealtimeValue {
  state: LinkState;
  lastSeq: number;
  lastChanges: EntityChangeDto[];
}

const RealtimeContext = createContext<RealtimeValue>({
  state: 'connecting',
  lastSeq: 0,
  lastChanges: []
});

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LinkState>('connecting');
  const [lastSeq, setLastSeq] = useState(0);
  const [lastChanges, setLastChanges] = useState<EntityChangeDto[]>([]);
  const cursorRef = useRef(0);

  useEffect(() => {
    const invalidateAll = () => queryClient.invalidateQueries();
    const updateCursor = (cursor: number) => {
      if (!Number.isFinite(cursor) || cursor <= cursorRef.current) return;
      cursorRef.current = cursor;
      setLastSeq(cursor);
    };
    const onHello = (cursor: number) => {
      if (cursorRef.current === 0) updateCursor(cursor);
    };
    const applyChangePayload = (payload: { cursor?: number; changes?: unknown[] }) => {
      const changes = Array.isArray(payload.changes) ? (payload.changes as EntityChangeDto[]) : [];
      const payloadCursor =
        typeof payload.cursor === 'number'
          ? payload.cursor
          : changes.length > 0
            ? (changes[changes.length - 1]?.seq ?? 0)
            : 0;
      updateCursor(payloadCursor);
      setLastChanges(changes);
      invalidateRealtimeChanges(queryClient, payload.changes);
    };
    const catchUp = async () => {
      let cursor = cursorRef.current;
      if (cursor <= 0) return;

      while (true) {
        const response = await fetchApi(`/sync/changes?after=${cursor}`);
        if (!response.ok) throw new Error('Realtime catch-up failed');
        const payload = (await response.json()) as Partial<SyncChangesDto>;
        applyChangePayload(payload);
        cursor = typeof payload.cursor === 'number' ? payload.cursor : cursorRef.current;
        if (!payload.hasMore) return;
      }
    };
    const onOpen = () => {
      const hadCursor = cursorRef.current > 0;
      if (!hadCursor) {
        setState('live');
        return;
      }
      void catchUp()
        .catch(() => {
          invalidateAll();
        })
        .finally(() => setState('live'));
    };

    // One SSE code path for every backend mode. `connectEventStream` sends the
    // Authorization header for remote/bearer backends and falls back to
    // `credentials: 'include'` (cookie auth) when no header is present, so the
    // local same-origin case no longer needs a separate native EventSource branch.
    return connectEventStream({
      url: () =>
        resolveEventSourceUrl(
          cursorRef.current > 0 ? `/realtime?after=${cursorRef.current}` : '/realtime'
        ),
      headers: getAuthorizationHeader(),
      handlers: {
        onOpen,
        onHello,
        onChange: payload => {
          setState('live');
          applyChangePayload(payload);
        },
        onRefresh: () => {
          setState('live');
          invalidateAll();
        },
        onError: () => setState('reconnecting')
      }
    });
  }, [queryClient]);

  return (
    <RealtimeContext.Provider value={{ state, lastSeq, lastChanges }}>
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtime(): RealtimeValue {
  return useContext(RealtimeContext);
}

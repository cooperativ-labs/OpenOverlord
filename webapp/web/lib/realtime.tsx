import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

import type { EntityChangeDto } from '../../shared/contract.ts';

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

/**
 * Holds one SSE connection to `GET /api/stream` for the whole app. Every delta
 * (or coarse refresh) invalidates the TanStack Query cache, so any change to the
 * underlying database — whether made here or by the CLI — is reflected live.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LinkState>('connecting');
  const [lastSeq, setLastSeq] = useState(0);
  const [lastChanges, setLastChanges] = useState<EntityChangeDto[]>([]);

  useEffect(() => {
    const source = new EventSource('/api/stream');

    const onLive = () => setState('live');
    const invalidateAll = () => queryClient.invalidateQueries();

    source.addEventListener('open', onLive);
    source.addEventListener('hello', event => {
      onLive();
      try {
        setLastSeq(JSON.parse((event as MessageEvent).data).cursor ?? 0);
      } catch {
        /* ignore */
      }
    });
    source.addEventListener('change', event => {
      onLive();
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          cursor?: number;
          changes?: EntityChangeDto[];
        };
        setLastSeq(payload.cursor ?? 0);
        setLastChanges(Array.isArray(payload.changes) ? payload.changes : []);
      } catch {
        /* ignore */
      }
      invalidateAll();
    });
    source.addEventListener('refresh', () => {
      onLive();
      invalidateAll();
    });
    source.addEventListener('error', () => {
      // EventSource auto-reconnects; reflect the gap in the UI meanwhile.
      setState('reconnecting');
    });

    return () => source.close();
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

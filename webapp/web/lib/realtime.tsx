import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

import type { EntityChangeDto } from '../../shared/contract.ts';

import { getBearerAuthorizationHeader, isRemoteBackend } from './api-base.ts';
import { resolveEventSourceUrl } from './api-transport.ts';
import { connectEventStream } from './fetch-sse.ts';

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

  useEffect(() => {
    const invalidateAll = () => queryClient.invalidateQueries();
    const onLive = () => setState('live');

    if (isRemoteBackend()) {
      const close = connectEventStream({
        url: resolveEventSourceUrl('/api/stream'),
        headers: getBearerAuthorizationHeader(),
        handlers: {
          onOpen: onLive,
          onHello: cursor => setLastSeq(cursor ?? 0),
          onChange: payload => {
            onLive();
            setLastSeq(payload.cursor ?? 0);
            setLastChanges(
              Array.isArray(payload.changes) ? (payload.changes as EntityChangeDto[]) : []
            );
            invalidateAll();
          },
          onRefresh: () => {
            onLive();
            invalidateAll();
          },
          onError: () => setState('reconnecting')
        }
      });
      return close;
    }

    const source = new EventSource('/api/stream');

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

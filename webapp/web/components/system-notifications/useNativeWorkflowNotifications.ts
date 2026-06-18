import { useEffect, useRef } from 'react';

import { notifyWorkflowChanges } from '../../lib/native-workflow-notifications.ts';
import { useRealtime } from '../../lib/realtime.tsx';

export function useNativeWorkflowNotifications() {
  const { lastSeq, lastChanges } = useRealtime();
  const handledSeq = useRef(0);

  useEffect(() => {
    if (lastSeq === 0 || lastSeq === handledSeq.current || lastChanges.length === 0) return;
    handledSeq.current = lastSeq;
    void notifyWorkflowChanges(lastChanges).catch(error => {
      console.warn('Unable to show workflow notification', error);
    });
  }, [lastChanges, lastSeq]);
}

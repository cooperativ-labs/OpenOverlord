type SseHandlers = {
  onOpen?: () => void;
  onHello?: (cursor: number) => void;
  onChange?: (payload: { cursor?: number; changes?: unknown[] }) => void;
  onRefresh?: () => void;
  onError?: () => void;
};

export function connectEventStream({
  url,
  headers,
  handlers
}: {
  url: string;
  headers?: Record<string, string>;
  handlers: SseHandlers;
}): () => void {
  const controller = new AbortController();
  let buffer = '';

  void (async () => {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        credentials: 'include',
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        handlers.onError?.();
        return;
      }

      handlers.onOpen?.();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let eventName = 'message';
      let dataLines: string[] = [];

      const dispatch = () => {
        const data = dataLines.join('\n');
        dataLines = [];
        if (eventName === 'hello') {
          try {
            handlers.onHello?.(JSON.parse(data).cursor ?? 0);
          } catch {
            handlers.onHello?.(0);
          }
        } else if (eventName === 'change') {
          try {
            handlers.onChange?.(JSON.parse(data));
          } catch {
            handlers.onChange?.({});
          }
        } else if (eventName === 'refresh') {
          handlers.onRefresh?.();
        }
        eventName = 'message';
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventName = line.slice('event:'.length).trim();
            continue;
          }
          if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).trimStart());
            continue;
          }
          if (line.trim().length === 0) {
            dispatch();
          }
        }
      }
      dispatch();
    } catch {
      if (!controller.signal.aborted) handlers.onError?.();
    }
  })();

  return () => controller.abort();
}

type SseHandlers = {
  onOpen?: () => void;
  onHello?: (cursor: number) => void;
  onChange?: (payload: { cursor?: number; changes?: unknown[] }) => void;
  onRefresh?: () => void;
  onError?: () => void;
};

const RECONNECT_DELAY_MS = 2_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timeout = globalThis.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        globalThis.clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

export function connectEventStream({
  url,
  headers,
  handlers
}: {
  url: string | (() => string);
  headers?: Record<string, string>;
  handlers: SseHandlers;
}): () => void {
  const controller = new AbortController();

  void (async () => {
    while (!controller.signal.aborted) {
      let buffer = '';
      try {
        const response = await fetch(typeof url === 'function' ? url() : url, {
          method: 'GET',
          headers,
          credentials: headers?.Authorization ? 'omit' : 'include',
          signal: controller.signal
        });
        if (!response.ok || !response.body) {
          handlers.onError?.();
          await sleep(RECONNECT_DELAY_MS, controller.signal);
          continue;
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
        // The AbortController owns intentional shutdown; every other failure
        // triggers a reconnect attempt after reporting the degraded state.
      }
      if (!controller.signal.aborted) handlers.onError?.();
      await sleep(RECONNECT_DELAY_MS, controller.signal);
    }
  })();

  return () => controller.abort();
}

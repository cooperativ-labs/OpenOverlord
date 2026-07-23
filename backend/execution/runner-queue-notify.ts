/** Postgres-only wake primitive for runner claim long-polls. */
const QUEUE_CHANNEL = 'overlord_execution_request_queue';

export const RUNNER_CLAIM_LONG_POLL_MS = 25_000;

type NotificationClient = {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification' | 'error', listener: (value: unknown) => void): void;
};

export interface RunnerQueueListener {
  wait(): Promise<void>;
  close(): Promise<void>;
}

/** Create and arm a dedicated non-pooled listener. Resolves after LISTEN is active. */
export async function createRunnerQueueListener({
  connectionString = process.env.DATABASE_URL,
  timeoutMs = RUNNER_CLAIM_LONG_POLL_MS,
  createClient
}: {
  connectionString?: string;
  timeoutMs?: number;
  createClient?: (connectionString: string) => Promise<NotificationClient>;
} = {}): Promise<RunnerQueueListener | null> {
  if (!connectionString) return null;
  const client = createClient
    ? await createClient(connectionString)
    : await (async () => {
        const pg = await import('pg');
        const Client = (pg.default ?? pg).Client;
        return new Client({ connectionString }) as NotificationClient;
      })();
  try {
    await client.connect();
    await client.query(`LISTEN ${QUEUE_CHANNEL}`);
  } catch {
    await client.end().catch(() => undefined);
    return null;
  }

  let settled = false;
  let resolveWait: (() => void) | null = null;
  const finish = () => {
    if (settled) return;
    settled = true;
    resolveWait?.();
  };
  client.on('notification', finish);
  client.on('error', finish);
  return {
    wait: () =>
      new Promise<void>(resolve => {
        const timer = setTimeout(finish, timeoutMs);
        resolveWait = () => {
          clearTimeout(timer);
          resolve();
        };
        if (settled) resolveWait();
      }),
    close: async () => {
      settled = true;
      await client.end().catch(() => undefined);
    }
  };
}

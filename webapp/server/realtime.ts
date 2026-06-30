import type { Response } from 'express';

import type { EntityChangeDto, SyncChangesDto } from '../shared/contract.ts';

import { currentMaxSeq, requireDatabaseClient } from './db.ts';

const CHANGE_BATCH_LIMIT = 500;

export interface ChangeRow {
  seq: number;
  entity_type: string;
  entity_id: string;
  operation: EntityChangeDto['operation'];
  project_id: string | null;
  mission_id: string | null;
  objective_id: string | null;
  changed_fields_json: string | null;
  occurred_at: string;
}

const SELECT_CHANGES_SQL = `
  SELECT seq, entity_type, entity_id, operation, project_id, mission_id, objective_id,
         changed_fields_json, occurred_at
    FROM entity_changes
   WHERE seq > ?
   ORDER BY seq ASC
   LIMIT ?
`;

export function parseChangedFields(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((field): field is string => typeof field === 'string');
  } catch {
    return [];
  }
}

export function entityChangeDtoFromRow(row: ChangeRow): EntityChangeDto {
  return {
    seq: row.seq,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    projectId: row.project_id,
    missionId: row.mission_id,
    objectiveId: row.objective_id,
    changedFields: parseChangedFields(row.changed_fields_json),
    occurredAt: row.occurred_at
  };
}

export type ChangeFeedBatch = SyncChangesDto;

export async function readChangesAfter(
  afterSeq: number,
  limit = CHANGE_BATCH_LIMIT
): Promise<ChangeFeedBatch> {
  const normalizedAfter = Number.isFinite(afterSeq) && afterSeq > 0 ? Math.floor(afterSeq) : 0;
  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : CHANGE_BATCH_LIMIT;
  const normalizedLimit = Math.max(1, Math.min(requestedLimit, CHANGE_BATCH_LIMIT));
  const rows = await requireDatabaseClient().all<ChangeRow>(SELECT_CHANGES_SQL, [
    normalizedAfter,
    normalizedLimit + 1
  ]);
  const hasMore = rows.length > normalizedLimit;
  const returnedRows = hasMore ? rows.slice(0, normalizedLimit) : rows;
  const changes = returnedRows.map(entityChangeDtoFromRow);
  const cursor = changes.length > 0 ? changes[changes.length - 1]!.seq : normalizedAfter;

  return { changes, cursor, hasMore };
}

/**
 * Tracks SSE subscribers and turns `entity_changes` rows into realtime deltas.
 *
 * Two detection paths keep the UI honest no matter who wrote to the database:
 *  1. The `entity_changes` seq cursor catches every mutation the web server and
 *     the CLI service layer record (the normal path) and forwards the deltas.
 *  2. `PRAGMA data_version` changes on any *external* connection commit; if it
 *     moves without new feed rows (a tool wrote a table directly), we emit a
 *     coarse `refresh` so clients refetch rather than miss the change.
 */
class RealtimeHub {
  private readonly clients = new Set<Response>();
  private cursor = 0;
  private lastDataVersion: number | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.pollTimer) return;
    void this.initializeCursor();
    this.pollTimer = setInterval(() => void this.poll(), 500);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 25_000);
  }

  addClient(res: Response, options: { afterSeq?: number } = {}): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    this.send(res, 'hello', { type: 'hello', cursor: this.cursor });
    if (options.afterSeq !== undefined && options.afterSeq < this.cursor) {
      void this.sendCatchUp(res, options.afterSeq);
    }
  }

  removeClient(res: Response): void {
    this.clients.delete(res);
  }

  /** Run a poll immediately — used right after a local mutation for snappy echoes. */
  pollNow(): void {
    void this.poll();
  }

  /**
   * Force every subscriber to refetch. Used for server-state changes that do not
   * write to `entity_changes` — notably switching the active workspace, which
   * changes what every scoped query returns.
   */
  refreshAll(): void {
    this.broadcast('refresh', { type: 'refresh' });
  }

  private async initializeCursor(): Promise<void> {
    const client = requireDatabaseClient();
    this.cursor = await currentMaxSeq(client);
    this.lastDataVersion = (await client.sqliteDataVersion?.()) ?? null;
  }

  private async poll(): Promise<void> {
    const client = requireDatabaseClient();
    if (this.clients.size === 0) {
      // Keep the cursor moving even with no subscribers so a later client does
      // not get flooded with backlog it does not need.
      this.cursor = await currentMaxSeq(client);
      this.lastDataVersion = (await client.sqliteDataVersion?.()) ?? null;
      return;
    }

    const rows = await client.all<ChangeRow>(SELECT_CHANGES_SQL, [this.cursor, CHANGE_BATCH_LIMIT]);
    if (rows.length > 0) {
      const changes: EntityChangeDto[] = rows.map(entityChangeDtoFromRow);
      this.cursor = rows[rows.length - 1]!.seq;
      this.broadcast('change', { type: 'change', changes, cursor: this.cursor });
    }

    // SQLite-only external-write net: `sqliteDataVersion()` returns null on
    // Postgres, so this branch never fires there (the feed is the sole detector).
    const version = (await client.sqliteDataVersion?.()) ?? null;
    if (version !== null && version !== this.lastDataVersion) {
      this.lastDataVersion = version;
      if (rows.length === 0) {
        // External write that did not (or has not yet) produced feed rows.
        this.broadcast('refresh', { type: 'refresh' });
      }
    }
  }

  private heartbeat(): void {
    for (const res of this.clients) res.write(': ping\n\n');
  }

  private broadcast(event: string, data: unknown): void {
    for (const res of this.clients) this.send(res, event, data);
  }

  private async sendCatchUp(res: Response, afterSeq: number): Promise<void> {
    let cursor = afterSeq;
    while (this.clients.has(res)) {
      const batch = await readChangesAfter(cursor);
      if (batch.changes.length === 0) return;
      this.send(res, 'change', { type: 'change', changes: batch.changes, cursor: batch.cursor });
      cursor = batch.cursor;
      if (!batch.hasMore) return;
    }
  }

  private send(res: Response, event: string, data: unknown): void {
    res.write(`event: ${event}\n`);
    const cursor =
      typeof data === 'object' && data && 'cursor' in data
        ? Number((data as { cursor?: unknown }).cursor)
        : NaN;
    if (Number.isFinite(cursor)) res.write(`id: ${cursor}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

export const realtime = new RealtimeHub();

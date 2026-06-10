import type { Response } from 'express';

import type { EntityChangeDto } from '../shared/contract.ts';

import { currentMaxSeq, dataVersion, db } from './db.ts';

interface ChangeRow {
  seq: number;
  entity_type: string;
  entity_id: string;
  operation: EntityChangeDto['operation'];
  project_id: string | null;
  ticket_id: string | null;
  objective_id: string | null;
  occurred_at: string;
}

const selectChangesStmt = db.prepare(`
  SELECT seq, entity_type, entity_id, operation, project_id, ticket_id, objective_id, occurred_at
    FROM entity_changes
   WHERE seq > ?
   ORDER BY seq ASC
   LIMIT 500
`);

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
  private cursor = currentMaxSeq();
  private lastDataVersion = dataVersion();
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), 500);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 25_000);
  }

  addClient(res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    this.send(res, 'hello', { type: 'hello', cursor: this.cursor });
  }

  removeClient(res: Response): void {
    this.clients.delete(res);
  }

  /** Run a poll immediately — used right after a local mutation for snappy echoes. */
  pollNow(): void {
    this.poll();
  }

  private poll(): void {
    if (this.clients.size === 0) {
      // Keep the cursor moving even with no subscribers so a later client does
      // not get flooded with backlog it does not need.
      this.cursor = currentMaxSeq();
      this.lastDataVersion = dataVersion();
      return;
    }

    const rows = selectChangesStmt.all(this.cursor) as ChangeRow[];
    if (rows.length > 0) {
      const changes: EntityChangeDto[] = rows.map(r => ({
        seq: r.seq,
        entityType: r.entity_type,
        entityId: r.entity_id,
        operation: r.operation,
        projectId: r.project_id,
        ticketId: r.ticket_id,
        objectiveId: r.objective_id,
        occurredAt: r.occurred_at
      }));
      this.cursor = rows[rows.length - 1]!.seq;
      this.broadcast('change', { type: 'change', changes, cursor: this.cursor });
    }

    const version = dataVersion();
    if (version !== this.lastDataVersion) {
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

  private send(res: Response, event: string, data: unknown): void {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

export const realtime = new RealtimeHub();

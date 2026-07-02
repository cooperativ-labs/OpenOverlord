import type BetterSqlite3 from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';

import { type AdapterConfig } from './adapter.js';
import { openDatabase } from './connection.js';

/**
 * The async database client abstraction.
 *
 * The whole backend was written against synchronous `better-sqlite3`
 * (`db.prepare(sql).get(args)`), which cannot run on PostgreSQL because the
 * Postgres driver (`pg`) is asynchronous. `DatabaseClient` hides that split
 * behind a single async surface so the same hand-written SQL runs on either
 * adapter: the SQLite implementation wraps `better-sqlite3` (resolving its
 * synchronous results as already-settled promises), and the Postgres
 * implementation runs against a `pg` pool/connection.
 *
 * Call sites keep their existing SQL strings and convert mechanically:
 *
 *   const row = db.prepare(`SELECT ... WHERE id = ?`).get(id);
 *   // becomes
 *   const row = await db.get(`SELECT ... WHERE id = ?`, [id]);
 *
 * Placeholders stay `?` everywhere; the Postgres client rewrites them to
 * `$1..$n`. Genuinely dialect-specific SQL (e.g. `FOR UPDATE SKIP LOCKED` on the
 * queue-claim path) is gated on `client.dialect`.
 *
 * Transactions are ambient: while a root client's `transaction(async tx => ...)`
 * callback is running, any query issued through that same root client from
 * within that async context automatically joins the open transaction instead of
 * deadlocking (SQLite) or running outside the transaction on another pooled
 * connection (Postgres). See `TransactionClosedError` and the "Ambient
 * Transactions" section of the database schema contract for details.
 */
export type SqlDialect = 'sqlite' | 'postgres';

/**
 * Thrown when a query is issued through a transaction-scoped `DatabaseClient`
 * (the `tx` passed to a `transaction()` callback) after that transaction has
 * already committed or rolled back. This mainly guards against detached
 * fire-and-forget work spawned inside a callback (e.g. an unawaited realtime
 * poll trigger) that captured `tx` and outlives it — such code fails loudly
 * instead of silently reusing a released/committed connection.
 */
export class TransactionClosedError extends Error {
  constructor(message = 'DatabaseClient used after its transaction committed or rolled back') {
    super(message);
    this.name = 'TransactionClosedError';
  }
}

/** Bind a boolean for a `?` placeholder — Postgres expects `boolean`, SQLite `0|1`. */
export function bindBool(dialect: SqlDialect, value: boolean): boolean | number {
  return dialect === 'postgres' ? value : value ? 1 : 0;
}

/** Inline SQL boolean literal when a `?` placeholder is awkward (e.g. inside `CASE`). */
export function sqlBoolLiteral(dialect: SqlDialect, value: boolean): string {
  if (dialect === 'postgres') return value ? 'true' : 'false';
  return value ? '1' : '0';
}

/**
 * Aggregate expression that joins a grouped column's values into one string,
 * separated by `separator`. SQLite spells this `GROUP_CONCAT(expr, sep)`; Postgres
 * spells it `STRING_AGG(expr, sep)` and the two names are not interchangeable, so
 * any shared query that aggregates text has to go through this helper to stay
 * dialect-agnostic. The separator is embedded as a quoted SQL string literal
 * (single quotes are escaped); it is intended for constant separators like `','`
 * or `'\n'`, not for user input.
 */
export function groupConcat(dialect: SqlDialect, expr: string, separator: string): string {
  const literal = `'${separator.replace(/'/g, "''")}'`;
  const fn = dialect === 'postgres' ? 'STRING_AGG' : 'GROUP_CONCAT';
  return `${fn}(${expr}, ${literal})`;
}

export interface RunResult {
  /** Rows affected (`better-sqlite3` `changes` / `pg` `rowCount`). */
  changes: number;
  /** SQLite-only autoincrement rowid; never populated on Postgres. */
  lastInsertRowid?: number | bigint;
}

export interface DatabaseClient {
  readonly dialect: SqlDialect;
  /** Run a query and return the first row, or `undefined` when none match. */
  get<T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ): Promise<T | undefined>;
  /** Run a query and return every row. */
  all<T = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]>;
  /** Run a write statement and return the affected-row count. */
  run(sql: string, params?: ReadonlyArray<unknown>): Promise<RunResult>;
  /** Execute one or more statements with no parameters (DDL / migration SQL). */
  exec(sql: string): Promise<void>;
  /**
   * Run `fn` inside a transaction, passing a transaction-scoped client. The
   * transaction commits when `fn` resolves and rolls back if it throws. Nested
   * calls use SAVEPOINTs so composing transactional service functions is safe.
   *
   * Ambient join: while `fn` runs, queries issued through the root client
   * (not just the `tx` argument) automatically join this transaction — see the
   * module doc comment. Passing `tx` explicitly is still correct and preferred
   * for readability; the ambient behavior is a safety net, not a replacement.
   */
  transaction<T>(fn: (tx: DatabaseClient) => Promise<T>): Promise<T>;
  /**
   * SQLite-only external-write probe: the current `PRAGMA data_version`, which
   * advances when any *other* connection commits to the database file. The
   * realtime poller uses it to emit a coarse `refresh` when a tool wrote a table
   * directly without appending to the `entity_changes` feed. Returns `null` on
   * Postgres, where the hosted edition relies solely on the feed (every writer
   * goes through the service layer). Optional so lightweight test doubles need
   * not implement it; treat an absent method as `null`.
   */
  sqliteDataVersion?(): Promise<number | null>;
  /** Release the underlying handle/pool. */
  close(): Promise<void>;
}

/**
 * Rewrite positional `?` placeholders to Postgres `$1..$n`, skipping any `?`
 * inside single-quoted string literals. Our SQL never embeds a literal `?` in a
 * string, but the scan keeps the translation correct if one ever appears.
 */
export function toPostgresPlaceholders(sql: string): string {
  let out = '';
  let index = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      // A doubled '' inside a string is an escaped quote, not a terminator.
      if (inString && sql[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inString = !inString;
      out += ch;
      continue;
    }
    if (ch === '?' && !inString) {
      index++;
      out += `$${index}`;
      continue;
    }
    out += ch;
  }
  return out;
}

// ---- SQLite implementation ----------------------------------------------

/**
 * Serializes async operations on a single `better-sqlite3` handle. The handle is
 * synchronous, but once call sites `await` between statements the event loop can
 * interleave two requests' work — which would let a statement from one request
 * land inside another's open `BEGIN…COMMIT`. The mutex makes each top-level
 * operation (and each whole transaction) run to completion before the next
 * starts, preserving the atomicity the synchronous code relied on.
 */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn);
    // Keep the chain alive even if `fn` rejects, without surfacing the rejection
    // on the internal tail (callers get it through the returned promise).
    this.#tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

class SqliteClient implements DatabaseClient {
  readonly dialect = 'sqlite' as const;
  readonly #db: BetterSqlite3.Database;
  readonly #mutex: Mutex;
  readonly #inTransaction: boolean;
  /**
   * Ambient-transaction store, owned only by root (non-tx) instances — never a
   * module-level singleton, so unrelated `SqliteClient` instances (e.g. two
   * adapters under test in the same process) never cross-contaminate each
   * other's open transaction. A tx/savepoint client always has this `undefined`
   * and must never consult it; it already runs directly against `#db`.
   */
  readonly #als: AsyncLocalStorage<SqliteClient> | undefined;
  #savepointDepth = 0;
  #closed = false;

  constructor(
    db: BetterSqlite3.Database,
    options: { mutex?: Mutex; inTransaction?: boolean } = {}
  ) {
    this.#db = db;
    this.#mutex = options.mutex ?? new Mutex();
    this.#inTransaction = options.inTransaction ?? false;
    this.#als = this.#inTransaction ? undefined : new AsyncLocalStorage<SqliteClient>();
  }

  /** The open transaction client for this root client's current async context, if any. */
  #ambientTx(): SqliteClient | undefined {
    return this.#als?.getStore();
  }

  #checkClosed(): void {
    if (this.#closed) throw new TransactionClosedError();
  }

  #guard<T>(fn: () => T): Promise<T> {
    // Inside a transaction the mutex is already held by `transaction()`; taking
    // it again would deadlock, so run directly.
    if (this.#inTransaction) return Promise.resolve().then(fn);
    return this.#mutex.runExclusive(() => Promise.resolve().then(fn));
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown> = []
  ): Promise<T | undefined> {
    this.#checkClosed();
    const ambient = this.#ambientTx();
    if (ambient) return ambient.get<T>(sql, params);
    return this.#guard(() => this.#db.prepare(sql).get(...params) as T | undefined);
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown> = []
  ): Promise<T[]> {
    this.#checkClosed();
    const ambient = this.#ambientTx();
    if (ambient) return ambient.all<T>(sql, params);
    return this.#guard(() => this.#db.prepare(sql).all(...params) as T[]);
  }

  async run(sql: string, params: ReadonlyArray<unknown> = []): Promise<RunResult> {
    this.#checkClosed();
    const ambient = this.#ambientTx();
    if (ambient) return ambient.run(sql, params);
    return this.#guard(() => {
      const result = this.#db.prepare(sql).run(...params);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    });
  }

  async exec(sql: string): Promise<void> {
    this.#checkClosed();
    const ambient = this.#ambientTx();
    if (ambient) return ambient.exec(sql);
    await this.#guard(() => this.#db.exec(sql));
  }

  async transaction<T>(fn: (tx: DatabaseClient) => Promise<T>): Promise<T> {
    this.#checkClosed();
    if (this.#inTransaction) {
      // Nested transaction → SAVEPOINT on the same handle (mutex already held).
      const name = `ovld_sp_${this.#savepointDepth++}`;
      this.#db.exec(`SAVEPOINT ${name}`);
      try {
        const out = await fn(this);
        this.#db.exec(`RELEASE ${name}`);
        return out;
      } catch (error) {
        this.#db.exec(`ROLLBACK TO ${name}`);
        this.#db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        this.#savepointDepth--;
      }
    }

    // Already inside an ambient transaction on this root client (e.g. a helper
    // called the root client's `transaction()` instead of threading `tx`
    // through) → join it as a nested SAVEPOINT instead of taking the mutex
    // again, which would deadlock.
    const ambient = this.#ambientTx();
    if (ambient) return ambient.transaction(fn);

    return this.#mutex.runExclusive(async () => {
      const tx = new SqliteClient(this.#db, { mutex: this.#mutex, inTransaction: true });
      this.#db.exec('BEGIN');
      try {
        const out = await this.#als!.run(tx, () => fn(tx));
        this.#db.exec('COMMIT');
        return out;
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      } finally {
        tx.#closed = true;
      }
    });
  }

  async sqliteDataVersion(): Promise<number | null> {
    this.#checkClosed();
    const ambient = this.#ambientTx();
    if (ambient) return ambient.sqliteDataVersion();
    return this.#guard(() => {
      const value = this.#db.pragma('data_version', { simple: true });
      return typeof value === 'number' ? value : Number(value);
    });
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}

/** Wrap an already-open `better-sqlite3` handle as a {@link DatabaseClient}. */
export function createSqliteClient(db: BetterSqlite3.Database): DatabaseClient {
  return new SqliteClient(db);
}

// ---- Postgres implementation --------------------------------------------

/** Minimal structural types so this module does not hard-depend on `pg`'s types. */
interface PgQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}
interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
}
interface PgPool extends PgQueryable {
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}
interface PgPoolClient extends PgQueryable {
  release(): void;
}

let pgTypeParsersConfigured = false;
let pgTypeParsersReady: Promise<void> | null = null;

function ensurePgTypeParsers(): Promise<void> {
  if (pgTypeParsersConfigured) return Promise.resolve();
  pgTypeParsersReady ??= configurePgTypeParsers();
  return pgTypeParsersReady;
}

/**
 * Make `pg` return values shaped like `better-sqlite3` so the shared SQL and the
 * row-mapping code do not have to branch per dialect:
 *
 * - `timestamptz`/`timestamp` → ISO-8601 strings (the app stores and compares
 *   timestamps as ISO text), instead of `Date` objects;
 * - `bigint` (`int8`, e.g. `entity_changes.seq`) → `number`, instead of strings;
 * - `json`/`jsonb` → the raw text, since call sites `JSON.parse(...)` these
 *   columns exactly as SQLite hands them back as text.
 * - `boolean` → `0 | 1`, since the shared row-mapping code was written against
 *   SQLite integer booleans and compares flags numerically.
 */
async function configurePgTypeParsers(): Promise<void> {
  if (pgTypeParsersConfigured) return;
  pgTypeParsersConfigured = true;
  const pg = await import('pg');
  const { types } = pg.default ?? pg;
  const toIso = (value: string | null): string | null =>
    value === null ? null : new Date(value).toISOString();
  types.setTypeParser(1114, toIso); // timestamp
  types.setTypeParser(1184, toIso); // timestamptz
  types.setTypeParser(20, (value: string | null) => (value === null ? null : Number(value))); // int8
  types.setTypeParser(16, (value: string | null) =>
    value === null ? null : value === 't' ? 1 : 0
  ); // bool
  const identity = (value: string | null): string | null => value;
  types.setTypeParser(114, identity); // json
  types.setTypeParser(3802, identity); // jsonb
}

class PostgresClient implements DatabaseClient {
  readonly dialect = 'postgres' as const;
  readonly #pool: PgPool | null;
  readonly #conn: PgQueryable;
  readonly #ownsPool: boolean;
  readonly #inTransaction: boolean;
  /** See {@link SqliteClient}'s `#als` — same per-root-instance rule applies here. */
  readonly #als: AsyncLocalStorage<PostgresClient> | undefined;
  #savepointDepth = 0;
  #closed = false;

  constructor(
    options: { pool: PgPool; ownsPool?: boolean } | { client: PgQueryable; inTransaction?: boolean }
  ) {
    if ('pool' in options) {
      this.#pool = options.pool;
      this.#conn = options.pool;
      this.#ownsPool = options.ownsPool ?? true;
      this.#inTransaction = false;
    } else {
      this.#pool = null;
      this.#conn = options.client;
      this.#ownsPool = false;
      this.#inTransaction = options.inTransaction ?? false;
    }
    this.#als = this.#inTransaction ? undefined : new AsyncLocalStorage<PostgresClient>();
  }

  /** The open transaction client for this root client's current async context, if any. */
  #ambientTx(): PostgresClient | undefined {
    return this.#als?.getStore();
  }

  #checkClosed(): void {
    if (this.#closed) throw new TransactionClosedError();
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown> = []
  ): Promise<T | undefined> {
    this.#checkClosed();
    const ambient = this.#ambientTx();
    if (ambient) return ambient.get<T>(sql, params);
    await ensurePgTypeParsers();
    const result = await this.#conn.query(toPostgresPlaceholders(sql), params as unknown[]);
    return result.rows[0] as T | undefined;
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown> = []
  ): Promise<T[]> {
    this.#checkClosed();
    const ambient = this.#ambientTx();
    if (ambient) return ambient.all<T>(sql, params);
    await ensurePgTypeParsers();
    const result = await this.#conn.query(toPostgresPlaceholders(sql), params as unknown[]);
    return result.rows as T[];
  }

  async run(sql: string, params: ReadonlyArray<unknown> = []): Promise<RunResult> {
    this.#checkClosed();
    const ambient = this.#ambientTx();
    if (ambient) return ambient.run(sql, params);
    await ensurePgTypeParsers();
    const result = await this.#conn.query(toPostgresPlaceholders(sql), params as unknown[]);
    return { changes: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    this.#checkClosed();
    const ambient = this.#ambientTx();
    if (ambient) return ambient.exec(sql);
    await ensurePgTypeParsers();
    await this.#conn.query(sql);
  }

  async transaction<T>(fn: (tx: DatabaseClient) => Promise<T>): Promise<T> {
    this.#checkClosed();
    if (!this.#pool) {
      if (!this.#inTransaction) {
        // Already inside an ambient transaction on this root client → join it
        // as a nested SAVEPOINT on the same session connection.
        const ambient = this.#ambientTx();
        if (ambient) return ambient.transaction(fn);

        await this.#conn.query('BEGIN');
        let tx: PostgresClient | undefined;
        try {
          tx = new PostgresClient({ client: this.#conn, inTransaction: true });
          const out = await this.#als!.run(tx, () => fn(tx!));
          await this.#conn.query('COMMIT');
          return out;
        } catch (error) {
          await this.#conn.query('ROLLBACK');
          throw error;
        } finally {
          if (tx) tx.#closed = true;
        }
      }

      const name = `ovld_sp_${this.#savepointDepth++}`;
      await this.#conn.query(`SAVEPOINT ${name}`);
      const tx = new PostgresClient({ client: this.#conn, inTransaction: true });
      try {
        const out = await fn(tx);
        await this.#conn.query(`RELEASE SAVEPOINT ${name}`);
        return out;
      } catch (error) {
        await this.#conn.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw error;
      } finally {
        this.#savepointDepth--;
        tx.#closed = true;
      }
    }

    // Pool-backed root: joining the ambient transaction (rather than checking
    // out a second pooled connection) is what fixes the out-of-transaction bug
    // — without it, a root-client query inside the callback would silently run
    // on a different connection than the one holding BEGIN.
    const ambient = this.#ambientTx();
    if (ambient) return ambient.transaction(fn);

    const client = await this.#pool.connect();
    let tx: PostgresClient | undefined;
    try {
      await client.query('BEGIN');
      tx = new PostgresClient({ client, inTransaction: true });
      const out = await this.#als!.run(tx, () => fn(tx!));
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      if (tx) tx.#closed = true;
      client.release();
    }
  }

  async sqliteDataVersion(): Promise<number | null> {
    // Postgres change-detection relies solely on the `entity_changes` feed; there
    // is no per-connection data_version equivalent in use here.
    return null;
  }

  async close(): Promise<void> {
    if (this.#ownsPool && this.#pool) await this.#pool.end();
  }
}

/** Wrap a `pg` pool (or any pool-shaped object) as a {@link DatabaseClient}. */
export function createPostgresClient(
  pool: PgPool,
  options: { ownsPool?: boolean } = {}
): DatabaseClient {
  return new PostgresClient({ pool, ownsPool: options.ownsPool ?? false });
}

/** Wrap one checked-out `pg` connection so every query shares the same session state. */
export function createPostgresSessionClient(client: PgQueryable): DatabaseClient {
  return new PostgresClient({ client });
}

// ---- Adapter-driven factory ---------------------------------------------

function postgresSearchPath(schema: string | undefined): string | undefined {
  if (!schema) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error('PostgreSQL schema must be a simple identifier');
  }
  return `-c search_path=${schema},public`;
}

/**
 * Construct the {@link DatabaseClient} selected by {@link AdapterConfig}. This is
 * the async-runtime counterpart to {@link openDatabase}: a `postgres` adapter
 * yields a `pg`-backed client, while a `sqlite` adapter opens the local file.
 * `pg` is imported lazily so the local SQLite path never loads it.
 */
export async function openDatabaseClient(adapter: AdapterConfig): Promise<DatabaseClient> {
  if (adapter.type === 'sqlite') {
    return new SqliteClient(openDatabase({ databasePath: adapter.path }));
  }
  await configurePgTypeParsers();
  const pg = await import('pg');
  const Pool = (pg.default ?? pg).Pool;
  const options = postgresSearchPath(adapter.schema);
  const pool = new Pool({
    connectionString: adapter.connectionString,
    ...(options ? { options } : {})
  }) as unknown as PgPool;
  return new PostgresClient({ pool, ownsPool: true });
}

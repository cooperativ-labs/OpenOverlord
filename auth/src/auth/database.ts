import type { DatabaseClient } from '@overlord/database';
import type BetterSqlite3 from 'better-sqlite3';

export interface PostgresQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface PostgresQueryExecutor {
  query<Row = unknown>(sql: string, values?: readonly unknown[]): Promise<PostgresQueryResult<Row>>;
}

/**
 * The async {@link DatabaseClient} (from `@overlord/database`) is the preferred
 * handle: it speaks `?` placeholders on both SQLite and Postgres (rewriting them
 * internally), so the auth queries below run unchanged on either edition through
 * a single code path. The raw `better-sqlite3` handle and the bare
 * {@link PostgresQueryExecutor} remain accepted for tests and legacy callers.
 */
export type AuthDomainDatabase = BetterSqlite3.Database | PostgresQueryExecutor | DatabaseClient;

function isDatabaseClient(db: AuthDomainDatabase): db is DatabaseClient {
  return (
    typeof (db as DatabaseClient).get === 'function' &&
    typeof (db as DatabaseClient).all === 'function' &&
    typeof (db as DatabaseClient).run === 'function'
  );
}

function isPostgresDatabase(db: AuthDomainDatabase): db is PostgresQueryExecutor {
  return typeof (db as PostgresQueryExecutor).query === 'function';
}

function toPostgresSql(sql: string): string {
  let parameterIndex = 0;
  return sql.replace(/\?/g, () => `$${++parameterIndex}`);
}

export async function queryOne<Row>(
  db: AuthDomainDatabase,
  sql: string,
  params: readonly unknown[] = []
): Promise<Row | undefined> {
  if (isDatabaseClient(db)) {
    return db.get<Row>(sql, params);
  }

  if (isPostgresDatabase(db)) {
    const result = await db.query<Row>(toPostgresSql(sql), params);
    return result.rows[0];
  }

  return db.prepare(sql).get(...params) as Row | undefined;
}

export async function queryAll<Row>(
  db: AuthDomainDatabase,
  sql: string,
  params: readonly unknown[] = []
): Promise<Row[]> {
  if (isDatabaseClient(db)) {
    return db.all<Row>(sql, params);
  }

  if (isPostgresDatabase(db)) {
    const result = await db.query<Row>(toPostgresSql(sql), params);
    return result.rows;
  }

  return db.prepare(sql).all(...params) as Row[];
}

export async function execute(
  db: AuthDomainDatabase,
  sql: string,
  params: readonly unknown[] = []
): Promise<void> {
  if (isDatabaseClient(db)) {
    await db.run(sql, params);
    return;
  }

  if (isPostgresDatabase(db)) {
    await db.query(toPostgresSql(sql), params);
    return;
  }

  db.prepare(sql).run(...params);
}

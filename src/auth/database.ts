import type BetterSqlite3 from 'better-sqlite3';

export interface PostgresQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface PostgresQueryExecutor {
  query<Row = unknown>(sql: string, values?: readonly unknown[]): Promise<PostgresQueryResult<Row>>;
}

export type AuthDomainDatabase = BetterSqlite3.Database | PostgresQueryExecutor;

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
  if (isPostgresDatabase(db)) {
    await db.query(toPostgresSql(sql), params);
    return;
  }

  db.prepare(sql).run(...params);
}

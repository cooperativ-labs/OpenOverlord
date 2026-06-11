import type { ColumnDefinition } from 'better-sqlite3';

import type {
  SqliteBrowserColumnDto,
  SqliteBrowserQueryResultDto,
  SqliteBrowserTableDataDto,
  SqliteBrowserTableDto
} from '../shared/contract.ts';

import { db } from './db.ts';
import { ApiError } from './repository.ts';

const DEFAULT_ROW_LIMIT = 100;
const MAX_ROW_LIMIT = 250;
const MAX_QUERY_ROWS = 250;

type SchemaRow = {
  name: string;
  type: 'table' | 'view';
  sql: string | null;
};

type TableInfoRow = {
  cid: number;
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  pk: number;
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function parseLimit(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value ?? NaN);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_ROW_LIMIT;
  return Math.min(parsed, MAX_ROW_LIMIT);
}

function parseOffset(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value ?? NaN);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function normalizeCell(value: unknown): string | number | boolean | null {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }
  return JSON.stringify(value);
}

function normalizeRow(
  row: Record<string, unknown>
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeCell(value)]));
}

function toColumnDto(column: TableInfoRow): SqliteBrowserColumnDto {
  return {
    name: column.name,
    type: column.type || 'TEXT',
    notNull: column.notnull === 1,
    defaultValue: column.dflt_value,
    primaryKeyPosition: column.pk
  };
}

function readColumns(tableName: string): SqliteBrowserColumnDto[] {
  const stmt = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
  return (stmt.all() as TableInfoRow[]).map(toColumnDto);
}

function readTableTotal(tableName: string): number {
  const tableRef = quoteIdentifier(tableName);
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableRef}`).get() as { count: number };
  return row.count;
}

function collectRows(
  statement: ReturnType<typeof db.prepare>,
  maxRows: number
): {
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
  truncated: boolean;
} {
  const columns = statement.columns().map((column: ColumnDefinition) => column.name);
  const rows: Array<Record<string, string | number | boolean | null>> = [];
  let truncated = false;
  let seen = 0;
  const iterate = statement.iterate.bind(statement) as () => Iterable<Record<string, unknown>>;

  for (const row of iterate()) {
    seen += 1;
    if (seen > maxRows) {
      truncated = true;
      break;
    }
    rows.push(normalizeRow(row));
  }

  return { columns, rows, truncated };
}

export function listSqliteTables(): SqliteBrowserTableDto[] {
  const tables = db
    .prepare(
      `SELECT name, type, sql
         FROM sqlite_schema
        WHERE type IN ('table', 'view')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name COLLATE NOCASE ASC`
    )
    .all() as SchemaRow[];

  return tables.map(table => ({
    name: table.name,
    type: table.type,
    columns: readColumns(table.name),
    rowCount: table.type === 'table' ? readTableTotal(table.name) : null,
    sql: table.sql
  }));
}

export function getSqliteTableData({
  tableName,
  limit,
  offset
}: {
  tableName: string;
  limit?: unknown;
  offset?: unknown;
}): SqliteBrowserTableDataDto {
  const table = listSqliteTables().find(candidate => candidate.name === tableName);
  if (!table) {
    throw new ApiError(404, `SQLite object not found: ${tableName}`);
  }

  const safeLimit = parseLimit(limit);
  const safeOffset = parseOffset(offset);
  const tableRef = quoteIdentifier(tableName);
  const statement = db.prepare(`SELECT * FROM ${tableRef} LIMIT ${safeLimit} OFFSET ${safeOffset}`);
  const { columns, rows } = collectRows(statement, safeLimit);

  return {
    table,
    columns,
    rows,
    limit: safeLimit,
    offset: safeOffset,
    totalRows: table.rowCount
  };
}

export function runSqliteQuery(sql: string): SqliteBrowserQueryResultDto {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new ApiError(400, 'Provide a SQL query to run.');
  }

  let statement: ReturnType<typeof db.prepare>;
  try {
    statement = db.prepare(trimmed);
  } catch (error) {
    throw new ApiError(
      400,
      'SQLite query could not be prepared.',
      error instanceof Error ? error.message : undefined
    );
  }

  if (!statement.reader) {
    throw new ApiError(400, 'Only read-only SQLite statements are allowed in the browser.');
  }

  const startedAt = Date.now();
  try {
    const { columns, rows, truncated } = collectRows(statement, MAX_QUERY_ROWS);
    return {
      sql: trimmed,
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    throw new ApiError(
      400,
      'SQLite query failed.',
      error instanceof Error ? error.message : undefined
    );
  }
}

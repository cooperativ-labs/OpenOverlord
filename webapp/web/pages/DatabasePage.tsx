import { Database, Play, Table2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Badge, Button, Card, EmptyState, Spinner, TextArea } from '@/components/ui.tsx';
import {
  useMeta,
  useRunSqliteQuery,
  useSqliteTableData,
  useSqliteTables
} from '@/lib/queries.ts';
import { cn } from '@/lib/utils';

import type { SqliteBrowserQueryResultDto } from '../../shared/contract.ts';

const DEFAULT_QUERY = `SELECT name, type, sql
FROM sqlite_schema
WHERE type IN ('table', 'view')
  AND name NOT LIKE 'sqlite_%'
ORDER BY name;`;

function DataGrid({
  columns,
  rows
}: {
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
}) {
  if (columns.length === 0) {
    return <EmptyState title="No columns returned" hint="Run a query that selects data." />;
  }

  return (
    <div className="overflow-auto rounded-lg border border-border">
      <table className="min-w-full border-collapse text-left text-sm">
        <thead className="sticky top-0 bg-card">
          <tr>
            {columns.map(column => (
              <th
                key={column}
                className="border-b border-border px-3 py-2 font-mono text-xs font-semibold text-muted-foreground"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-border/60 last:border-b-0">
              {columns.map(column => (
                <td
                  key={`${index}-${column}`}
                  className="max-w-80 px-3 py-2 align-top font-mono text-xs"
                >
                  <span className="break-words whitespace-pre-wrap">
                    {row[column] === null ? 'NULL' : String(row[column] ?? '')}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QueryResultSummary({ result }: { result: SqliteBrowserQueryResultDto }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Badge>{result.rowCount} rows</Badge>
      <span>{result.durationMs} ms</span>
      {result.truncated && <span>Showing the first 250 rows.</span>}
    </div>
  );
}

export function DatabasePage() {
  const meta = useMeta();
  const tables = useSqliteTables();
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [sql, setSql] = useState(DEFAULT_QUERY);
  const queryMutation = useRunSqliteQuery();

  useEffect(() => {
    if (!selectedTable && tables.data?.tables.length) {
      setSelectedTable(tables.data.tables[0]?.name ?? null);
    }
  }, [selectedTable, tables.data]);

  const tableData = useSqliteTableData(selectedTable, 100, offset);

  const selectedTableSummary = useMemo(
    () => tables.data?.tables.find(table => table.name === selectedTable) ?? null,
    [selectedTable, tables.data]
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-background">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-6 px-4 py-4 md:px-6">
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card/70 p-4 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Database className="size-4 text-muted-foreground" />
                <h1 className="text-lg font-semibold">SQLite Browser</h1>
              </div>
              <p className="max-w-3xl text-sm text-muted-foreground">
                Read-only browser for the local Overlord database. Table browsing and custom SQL
                are limited to reader statements.
              </p>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <div>{meta.data?.web.url}</div>
              <div className="font-mono">{meta.data?.databasePath}</div>
            </div>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
          <Card className="min-h-0 overflow-hidden p-0">
            <div className="border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <Table2 className="size-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">Tables and views</h2>
              </div>
            </div>
            <div className="max-h-[70vh] overflow-auto p-2">
              {tables.isLoading && <Spinner label="Loading schema…" />}
              {tables.isError && (
                <EmptyState
                  title="Could not load database schema"
                  hint={tables.error instanceof Error ? tables.error.message : 'Unknown error'}
                />
              )}
              {tables.data?.tables.map(table => (
                <button
                  key={table.name}
                  type="button"
                  className={cn(
                    'mb-2 w-full rounded-xl border px-3 py-3 text-left transition',
                    selectedTable === table.name
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-background hover:border-primary/40'
                  )}
                  onClick={() => {
                    setSelectedTable(table.name);
                    setOffset(0);
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium">{table.name}</span>
                    <Badge>{table.type}</Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>{table.columns.length} columns</span>
                    {table.rowCount !== null && <span>{table.rowCount} rows</span>}
                  </div>
                </button>
              ))}
            </div>
          </Card>

          <div className="grid min-h-0 gap-6">
            <Card className="overflow-hidden p-0">
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-semibold">
                      {selectedTableSummary ? selectedTableSummary.name : 'Preview'}
                    </h2>
                    {selectedTableSummary && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selectedTableSummary.columns.map(column => column.name).join(', ')}
                      </p>
                    )}
                  </div>
                  {selectedTableSummary && selectedTableSummary.rowCount !== null && (
                    <Badge>{selectedTableSummary.rowCount} rows</Badge>
                  )}
                </div>
              </div>
              <div className="space-y-4 p-4">
                {!selectedTable && <EmptyState title="Select a table" />}
                {selectedTable && tableData.isLoading && <Spinner label="Loading rows…" />}
                {selectedTable && tableData.isError && (
                  <EmptyState
                    title="Could not load rows"
                    hint={tableData.error instanceof Error ? tableData.error.message : 'Unknown error'}
                  />
                )}
                {tableData.data && (
                  <>
                    <DataGrid columns={tableData.data.columns} rows={tableData.data.rows} />
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs text-muted-foreground">
                        Offset {tableData.data.offset}
                        {tableData.data.totalRows !== null ? ` of ${tableData.data.totalRows}` : ''}
                      </div>
                      <div className="flex gap-2">
                        <Button
                          onClick={() =>
                            setOffset(current => Math.max(0, current - tableData.data.limit))
                          }
                          disabled={tableData.data.offset === 0}
                        >
                          Previous
                        </Button>
                        <Button
                          onClick={() => setOffset(current => current + tableData.data.limit)}
                          disabled={tableData.data.rows.length < tableData.data.limit}
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </Card>

            <Card className="overflow-hidden p-0">
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-semibold">Read-only SQL</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Allowed statements are whatever SQLite prepares as reader statements:
                      `SELECT`, `WITH`, `PRAGMA`, `EXPLAIN`, and similar non-mutating forms.
                    </p>
                  </div>
                  <Button
                    variant="primary"
                    onClick={() => queryMutation.mutate(sql)}
                    disabled={queryMutation.isPending}
                  >
                    <Play className="mr-2 size-4" />
                    Run query
                  </Button>
                </div>
              </div>
              <div className="space-y-4 p-4">
                <TextArea
                  value={sql}
                  onChange={event => setSql(event.target.value)}
                  className="min-h-32 font-mono text-xs"
                  spellCheck={false}
                />
                {queryMutation.isPending && <Spinner label="Running query…" />}
                {queryMutation.isError && (
                  <EmptyState
                    title="Query failed"
                    hint={
                      queryMutation.error instanceof Error
                        ? queryMutation.error.message
                        : 'Unknown error'
                    }
                  />
                )}
                {queryMutation.data && (
                  <div className="space-y-3">
                    <QueryResultSummary result={queryMutation.data} />
                    <DataGrid columns={queryMutation.data.columns} rows={queryMutation.data.rows} />
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

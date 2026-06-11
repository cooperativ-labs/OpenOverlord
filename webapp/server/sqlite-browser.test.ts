import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const testDir = mkdtempSync(path.join(tmpdir(), 'overlord-sqlite-browser-'));
const databasePath = path.join(testDir, 'Overlord.sqlite');

const setupDb = new Database(databasePath);
setupDb.exec(`
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE workspace_users (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE sample_rows (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    payload BLOB,
    active INTEGER NOT NULL
  );

  CREATE TABLE entity_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    project_id TEXT,
    ticket_id TEXT,
    objective_id TEXT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    entity_revision INTEGER,
    changed_fields_json TEXT NOT NULL,
    actor_workspace_user_id TEXT,
    actor_token_id TEXT,
    source TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  );

  INSERT INTO workspaces (id, slug, name, kind, created_at, deleted_at)
  VALUES ('workspace-1', 'local', 'Local', 'local', '2026-01-01T00:00:00.000Z', NULL);

  INSERT INTO workspace_users (id, workspace_id, status, created_at, deleted_at)
  VALUES ('workspace-user-1', 'workspace-1', 'active', '2026-01-01T00:00:00.000Z', NULL);

  INSERT INTO sample_rows (id, name, payload, active)
  VALUES (1, 'Alpha', x'0A0B', 1), (2, 'Beta', NULL, 0);
`);
setupDb.close();

process.env.OVERLORD_SQLITE_PATH = databasePath;

const { db } = await import('./db.ts');
const { getSqliteTableData, runSqliteQuery } = await import('./sqlite-browser.ts');

after(() => {
  db.close();
});

describe('SQLite browser', () => {
  it('loads table rows without detaching better-sqlite3 statement methods', () => {
    const result = getSqliteTableData({ tableName: 'sample_rows', limit: 10, offset: 0 });

    assert.deepEqual(result.columns, ['id', 'name', 'payload', 'active']);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0]?.name, 'Alpha');
    assert.equal(result.rows[0]?.payload, '0x0a0b');
    assert.equal(result.totalRows, 2);
  });

  it('runs read-only queries through the same row collector', () => {
    const result = runSqliteQuery('SELECT name FROM sample_rows ORDER BY id');

    assert.deepEqual(result.columns, ['name']);
    assert.deepEqual(
      result.rows.map(row => row.name),
      ['Alpha', 'Beta']
    );
    assert.equal(result.truncated, false);
  });
});

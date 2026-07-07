import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  finalizeExtEverhourMissionLinksSqlite,
  isExtEverhourPersistenceMigration
} from './ext-everhour-migration-runtime.js';
import {
  bindBool,
  CONTRACT_VERSION,
  DEFAULT_STATUSES,
  listSqliteMigrationFiles,
  loadBetterSqlite3,
  migrateDatabase,
  type OverlordDatabase
} from './index.js';
import { resolveAppliedMigrationSqlite } from './migration-ledger.js';
import {
  finalizeProjectResourcesResourceKeySqlite,
  isProjectResourcesResourceKeyMigration
} from './project-resources-resource-key-migration-runtime.js';

const EXT_EVERHOUR_MIGRATION = '20260706000000_ext_everhour_persistence.sql';

function sqliteMigrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sqlite', 'migrations');
}

function migrationComponent(fileName: string): string {
  const match = fileName.match(/^\d+_ext_([a-z0-9_]+)_/);
  return match ? `ext:${match[1]}` : 'core';
}

function applySqliteMigrationFile(db: OverlordDatabase, fileName: string): void {
  const version = fileName.split('_', 1)[0] ?? fileName;
  const sql = readFileSync(path.join(sqliteMigrationsDir(), fileName), 'utf8');
  const component = migrationComponent(fileName);
  const checksum = createHash('sha256').update(sql).digest('hex');

  const hasLedger = Boolean(
    db
      .prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'`)
      .get()
  );

  if (hasLedger) {
    const applied = resolveAppliedMigrationSqlite({
      db,
      migration: { version, component, checksum }
    });
    if (applied) {
      assert.equal(applied.checksum, checksum);
      return;
    }
  }

  db.exec(sql);
  if (isExtEverhourPersistenceMigration({ version, component })) {
    finalizeExtEverhourMissionLinksSqlite(db);
  }
  if (isProjectResourcesResourceKeyMigration({ version, component })) {
    finalizeProjectResourcesResourceKeySqlite(db);
  }

  if (
    db
      .prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'`)
      .get()
  ) {
    db.prepare(
      `INSERT INTO schema_migrations (version, adapter, component, contract_version, checksum, applied_at)
       VALUES (?, 'sqlite', ?, ?, ?, ?)`
    ).run(version, component, CONTRACT_VERSION, checksum, new Date().toISOString());
  }
}

function migrateUpToExtEverhour(db: OverlordDatabase): void {
  for (const fileName of listSqliteMigrationFiles()) {
    if (fileName === EXT_EVERHOUR_MIGRATION) break;
    applySqliteMigrationFile(db, fileName);
  }
}

function seedLegacyEverhourRows(db: OverlordDatabase): {
  workspaceId: string;
  projectId: string;
  missionId: string;
} {
  const now = '2026-07-06T12:00:00.000Z';
  const organizationId = 'legacy-org';
  const workspaceId = 'legacy-workspace';
  const projectId = 'legacy-project';
  const missionId = 'legacy-mission';
  const statusId = `${workspaceId}-in_progress`;

  db.prepare(
    `INSERT INTO organizations (id, name, settings_json, created_at, updated_at, revision)
     VALUES (?, ?, '{}', ?, ?, 1)`
  ).run(organizationId, 'Legacy Org', now, now);

  db.prepare(
    `INSERT INTO workspaces (
       id, organization_id, slug, name, kind, settings_json, created_at, updated_at, revision
     ) VALUES (?, ?, ?, ?, 'local', ?, ?, ?, 1)`
  ).run(
    workspaceId,
    organizationId,
    workspaceId,
    workspaceId,
    JSON.stringify({ everhourApiKey: 'legacy-api-key' }),
    now,
    now
  );

  const inProgress = DEFAULT_STATUSES.find(status => status.key === 'in_progress');
  assert.ok(inProgress);
  db.prepare(
    `INSERT INTO workspace_statuses (
       id, workspace_id, key, name, type, position, is_default, is_terminal,
       created_at, updated_at, revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(
    statusId,
    workspaceId,
    inProgress.key,
    inProgress.name,
    inProgress.type,
    inProgress.position,
    bindBool('sqlite', inProgress.isDefault),
    bindBool('sqlite', inProgress.isTerminal),
    now,
    now
  );

  db.prepare(
    `INSERT INTO projects (
       id, workspace_id, slug, name, status, settings_json, position, created_at, updated_at, revision
     ) VALUES (?, ?, ?, ?, 'active', ?, 1, ?, ?, 1)`
  ).run(
    projectId,
    workspaceId,
    'legacy-project',
    'Legacy Project',
    JSON.stringify({
      'overlord.everhourProjectId': 'ev:legacy-project',
      'overlord.everhourProjectName': 'Legacy Everhour Project',
      'overlord.everhourSectionId': '42'
    }),
    now,
    now
  );

  db.exec(`ALTER TABLE missions ADD COLUMN everhour_task_id TEXT`);

  db.prepare(
    `INSERT INTO missions (
       id, workspace_id, project_id, display_id, sequence_number, title, status_id, status_type,
       board_position, created_at, updated_at, revision, everhour_task_id
     ) VALUES (?, ?, ?, ?, 1, ?, ?, 'execute', 0, ?, ?, 1, ?)`
  ).run(
    missionId,
    workspaceId,
    projectId,
    'legacy:1',
    'Legacy mission',
    statusId,
    now,
    now,
    'ev:task-99'
  );

  return { workspaceId, projectId, missionId };
}

test('ext_everhour migration backfills legacy settings and records ext:everhour', () => {
  const Database = loadBetterSqlite3();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  try {
    migrateUpToExtEverhour(db);
    const { workspaceId, projectId, missionId } = seedLegacyEverhourRows(db);

    assert.ok(
      db.prepare(`SELECT everhour_task_id FROM missions WHERE id = ?`).get(missionId) as {
        everhour_task_id: string;
      }
    );

    applySqliteMigrationFile(db, EXT_EVERHOUR_MIGRATION);

    const connection = db
      .prepare(
        `SELECT api_key_secret FROM ext_everhour_workspace_connections
         WHERE workspace_id = ? AND deleted_at IS NULL`
      )
      .get(workspaceId) as { api_key_secret: string };
    assert.equal(connection.api_key_secret, 'legacy-api-key');

    const projectLink = db
      .prepare(
        `SELECT everhour_project_id, everhour_project_name, everhour_section_id
           FROM ext_everhour_project_links
          WHERE project_id = ? AND deleted_at IS NULL`
      )
      .get(projectId) as {
      everhour_project_id: string;
      everhour_project_name: string;
      everhour_section_id: string;
    };
    assert.equal(projectLink.everhour_project_id, 'ev:legacy-project');
    assert.equal(projectLink.everhour_project_name, 'Legacy Everhour Project');
    assert.equal(projectLink.everhour_section_id, '42');

    const missionLink = db
      .prepare(
        `SELECT everhour_task_id FROM ext_everhour_mission_links
         WHERE mission_id = ? AND deleted_at IS NULL`
      )
      .get(missionId) as { everhour_task_id: string };
    assert.equal(missionLink.everhour_task_id, 'ev:task-99');

    const missionColumns = db.prepare(`PRAGMA table_info(missions)`).all() as Array<{
      name: string;
    }>;
    assert.equal(
      missionColumns.some(column => column.name === 'everhour_task_id'),
      false
    );

    const ledger = db
      .prepare(
        `SELECT component FROM schema_migrations
         WHERE adapter = 'sqlite' AND version = '20260706000000'`
      )
      .get() as { component: string };
    assert.equal(ledger.component, 'ext:everhour');
  } finally {
    db.close();
  }
});

test('ext_everhour migration reconciles legacy core ledger record without re-running', () => {
  const Database = loadBetterSqlite3();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  try {
    migrateUpToExtEverhour(db);
    applySqliteMigrationFile(db, EXT_EVERHOUR_MIGRATION);

    db.prepare(
      `UPDATE schema_migrations
          SET component = 'core'
        WHERE adapter = 'sqlite' AND version = '20260706000000'`
    ).run();

    migrateDatabase(db);

    const ledger = db
      .prepare(
        `SELECT component FROM schema_migrations
         WHERE adapter = 'sqlite' AND version = '20260706000000'`
      )
      .get() as { component: string };
    assert.equal(ledger.component, 'ext:everhour');

    const missionColumns = db.prepare(`PRAGMA table_info(missions)`).all() as Array<{
      name: string;
    }>;
    assert.equal(
      missionColumns.some(column => column.name === 'everhour_task_id'),
      false
    );
  } finally {
    db.close();
  }
});

test('ext_everhour migration applies cleanly on fresh installs without legacy mission column', () => {
  const Database = loadBetterSqlite3();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  try {
    migrateUpToExtEverhour(db);
    applySqliteMigrationFile(db, EXT_EVERHOUR_MIGRATION);

    const missionColumns = db.prepare(`PRAGMA table_info(missions)`).all() as Array<{
      name: string;
    }>;
    assert.equal(
      missionColumns.some(column => column.name === 'everhour_task_id'),
      false
    );

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name LIKE 'ext_everhour_%'
         ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      tables.map(table => table.name),
      [
        'ext_everhour_mission_links',
        'ext_everhour_project_links',
        'ext_everhour_workspace_connections'
      ]
    );
  } finally {
    db.close();
  }
});

test('migrateDatabase prunes retired migration ledger versions', () => {
  const Database = loadBetterSqlite3();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  try {
    migrateDatabase(db);
    db.prepare(
      `INSERT INTO schema_migrations (
         version, adapter, component, contract_version, checksum, applied_at
       ) VALUES (?, 'sqlite', 'core', ?, 'retired', ?)`
    ).run('20260625000000', CONTRACT_VERSION, new Date().toISOString());

    migrateDatabase(db);

    const retired = db
      .prepare(
        `SELECT 1 FROM schema_migrations
         WHERE adapter = 'sqlite' AND version = '20260625000000'`
      )
      .get();
    assert.equal(retired, undefined);
  } finally {
    db.close();
  }
});

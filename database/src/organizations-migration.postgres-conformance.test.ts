import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { migrateDatabase, openInMemoryDatabase } from './connection.js';

/**
 * Fresh-install invariant for the organization -> workspace -> project
 * hierarchy (coo:135): after the full migration chain runs on a clean
 * database, there are zero organizations and zero workspaces (identity is
 * created via Better Auth sign-up + `ovld org-setup`, not seeded).
 *
 * The former Postgres "production rehearsal" suite in this file exercised the
 * one-time UUID-rekey / organization-backfill data path of the standalone
 * `20260704120000_organizations.sql` migration. That migration was folded into
 * `002_initial_core.sql` / `004_storage.sql` by the public-release migration
 * consolidation (coo:144): fresh installs now create the post-organization
 * schema directly, so there is no discrete rekey step left to rehearse, and
 * already-migrated production databases keep the result they already have (the
 * consolidation only rewrote their `schema_migrations` ledger during rollout).
 * The rehearsal was therefore removed; the schema-only fresh-install invariant
 * below remains.
 */
describe('fresh-install ends at zero organizations and zero workspaces [sqlite]', () => {
  it('has no organizations or workspaces after the full migration chain', () => {
    const sqlite = openInMemoryDatabase();
    migrateDatabase(sqlite);
    const orgCount = (
      sqlite.prepare('SELECT COUNT(*) AS count FROM organizations').get() as { count: number }
    ).count;
    const workspaceCount = (
      sqlite.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }
    ).count;
    assert.equal(orgCount, 0);
    assert.equal(workspaceCount, 0);
  });
});

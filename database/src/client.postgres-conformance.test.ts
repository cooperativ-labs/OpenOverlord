import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';

import {
  createPostgresClient,
  createSqliteClient,
  type DatabaseClient,
  TransactionClosedError
} from './client.js';
import { openInMemoryDatabase } from './connection.js';

/**
 * Conformance for the ambient-transaction mechanism in `client.ts` (coo:96): while a
 * root `DatabaseClient`'s `transaction(async tx => ...)` callback runs, any query
 * issued through that same root client — not just the `tx` argument — from within
 * that async context must join the open transaction, on both adapters. Previously
 * this deadlocked on SQLite (the transaction mutex is not reentrant) and silently
 * ran outside the transaction on a different pooled connection on Postgres.
 *
 * The same battery runs against SQLite (always) and PostgreSQL (when
 * `TEST_DATABASE_URL` points at a reachable Postgres), matching the other
 * `*.postgres-conformance.test.ts` suites in this repo.
 */

interface AdapterHandle {
  client: DatabaseClient;
  teardown: () => Promise<void>;
}

interface AdapterFactory {
  label: string;
  create: () => Promise<AdapterHandle>;
}

const TABLE_DDL = `CREATE TABLE ambient_tx_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)`;

const sqliteFactory: AdapterFactory = {
  label: 'sqlite',
  create: async () => {
    const sqlite = openInMemoryDatabase();
    const client = createSqliteClient(sqlite);
    await client.exec(TABLE_DDL);
    return {
      client,
      teardown: async () => {
        await client.close();
      }
    };
  }
};

function postgresFactory(connectionString: string): AdapterFactory {
  return {
    label: 'postgres',
    create: async () => {
      const pg = await import('pg');
      const Pool = (pg.default ?? pg).Pool;
      const schema = `ovld_ambient_tx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

      const admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA ${schema}`);

      // A real connection *pool* (not a single checked-out session) is essential
      // here: only the pool-backed root reproduces the original bug, where a
      // root-client query during an open transaction could be served by a
      // different pooled connection than the one holding BEGIN.
      const pool = new Pool({
        connectionString,
        options: `-c search_path=${schema},public`
      });
      const client = createPostgresClient(pool, { ownsPool: true });
      await client.exec(TABLE_DDL);

      return {
        client,
        teardown: async () => {
          await client.close();
          await admin.query(`DROP SCHEMA ${schema} CASCADE`);
          await admin.end();
        }
      };
    }
  };
}

const adapters: AdapterFactory[] = [sqliteFactory];
if (process.env.TEST_DATABASE_URL) {
  adapters.push(postgresFactory(process.env.TEST_DATABASE_URL));
}

/** Mirrors the coo:96 `deleteWorkspace` bug shape: a helper takes the ROOT client
 * (not the `tx` argument) and queries through it while a transaction is open
 * elsewhere in the same async context. */
async function helperThatUsesRootClient(rootClient: DatabaseClient, id: string): Promise<unknown> {
  return rootClient.get(`SELECT id FROM ambient_tx_probe WHERE id = ?`, [id]);
}

for (const adapter of adapters) {
  describe(`ambient transactions [${adapter.label}]`, () => {
    it(
      "a root-client query inside transaction() joins it and sees the transaction's uncommitted writes; rollback reverts them",
      { timeout: 5000 },
      async () => {
        const { client, teardown } = await adapter.create();
        try {
          await assert.rejects(
            client.transaction(async () => {
              await client.run(`INSERT INTO ambient_tx_probe (id, value) VALUES (?, ?)`, [
                'a',
                'v1'
              ]);
              // Query through the ROOT client, not the `tx` callback argument.
              const seen = await client.get<{ id: string }>(
                `SELECT id FROM ambient_tx_probe WHERE id = ?`,
                ['a']
              );
              assert.ok(seen, "root client must see its own transaction's uncommitted write");
              throw new Error('force rollback');
            }),
            /force rollback/
          );

          const after = await client.get(`SELECT id FROM ambient_tx_probe WHERE id = ?`, ['a']);
          assert.equal(after, undefined, 'rollback must revert the write the root client observed');
        } finally {
          await teardown();
        }
      }
    );

    it(
      'root transaction() called again inside a callback nests as a SAVEPOINT — an inner rollback does not abort the outer transaction',
      { timeout: 5000 },
      async () => {
        const { client, teardown } = await adapter.create();
        try {
          await client.transaction(async tx => {
            await tx.run(`INSERT INTO ambient_tx_probe (id, value) VALUES (?, ?)`, ['outer', 'v']);

            await assert.rejects(
              // Called on the ROOT client while its own transaction is ambiently
              // open — must delegate to a nested SAVEPOINT, not re-take the mutex
              // or open a second top-level transaction.
              client.transaction(async () => {
                await client.run(`INSERT INTO ambient_tx_probe (id, value) VALUES (?, ?)`, [
                  'inner',
                  'v'
                ]);
                throw new Error('force inner rollback');
              }),
              /force inner rollback/
            );
          });

          const outerRow = await client.get(`SELECT id FROM ambient_tx_probe WHERE id = ?`, [
            'outer'
          ]);
          const innerRow = await client.get(`SELECT id FROM ambient_tx_probe WHERE id = ?`, [
            'inner'
          ]);
          assert.ok(outerRow, 'outer transaction should have committed');
          assert.equal(
            innerRow,
            undefined,
            'inner nested transaction should have rolled back alone'
          );
        } finally {
          await teardown();
        }
      }
    );

    it(
      'a root query started outside the callback does not join the ambient transaction and completes without deadlock',
      { timeout: 5000 },
      async () => {
        const { client, teardown } = await adapter.create();
        try {
          await client.run(`INSERT INTO ambient_tx_probe (id, value) VALUES (?, ?)`, [
            'seed',
            'v0'
          ]);

          let releaseTx: () => void = () => {};
          const gate = new Promise<void>(resolve => {
            releaseTx = resolve;
          });

          const txPromise = client.transaction(async tx => {
            await tx.run(`UPDATE ambient_tx_probe SET value = ? WHERE id = ?`, ['v1', 'seed']);
            // Hold the transaction open until the outside query has been issued,
            // so the two calls genuinely overlap in time.
            await gate;
          });

          // Give the transaction a moment to start (and, on SQLite, take the mutex)
          // before issuing the unrelated query from a separate async context.
          await new Promise(resolve => setTimeout(resolve, 10));
          const outsidePromise = client.get<{ value: string }>(
            `SELECT value FROM ambient_tx_probe WHERE id = ?`,
            ['seed']
          );
          await new Promise(resolve => setTimeout(resolve, 10));
          releaseTx();

          const [, outsideResult] = await Promise.all([txPromise, outsidePromise]);

          // The main regression this guards is a hang; `Promise.all` resolving at
          // all proves that. It must also reflect a fully-committed value — never
          // an ambient view into the other async context's open transaction.
          assert.ok(outsideResult);
          assert.ok(['v0', 'v1'].includes(outsideResult.value));

          const final = await client.get<{ value: string }>(
            `SELECT value FROM ambient_tx_probe WHERE id = ?`,
            ['seed']
          );
          assert.equal(final?.value, 'v1');
        } finally {
          await teardown();
        }
      }
    );

    it(
      'a captured tx client used after its transaction commits throws TransactionClosedError',
      { timeout: 5000 },
      async () => {
        const { client, teardown } = await adapter.create();
        try {
          let captured: DatabaseClient | undefined;
          await client.transaction(async tx => {
            captured = tx;
            await tx.run(`INSERT INTO ambient_tx_probe (id, value) VALUES (?, ?)`, [
              'closed-probe',
              'v'
            ]);
          });

          assert.ok(captured);
          await assert.rejects(
            () => captured!.get(`SELECT 1 AS one`),
            (error: unknown) => error instanceof TransactionClosedError
          );
        } finally {
          await teardown();
        }
      }
    );

    it(
      'regression (coo:96 shape): a helper querying via the root client from inside a transaction works',
      { timeout: 5000 },
      async () => {
        const { client, teardown } = await adapter.create();
        try {
          await client.transaction(async tx => {
            await tx.run(`INSERT INTO ambient_tx_probe (id, value) VALUES (?, ?)`, [
              'helper-shape',
              'v'
            ]);
            const seen = await helperThatUsesRootClient(client, 'helper-shape');
            assert.ok(
              seen,
              "helper using the root client must see the open transaction's own write"
            );
          });

          const committed = await client.get(`SELECT id FROM ambient_tx_probe WHERE id = ?`, [
            'helper-shape'
          ]);
          assert.ok(committed, 'transaction should have committed once the callback resolved');
        } finally {
          await teardown();
        }
      }
    );
  });
}

after(() => {
  if (!process.env.TEST_DATABASE_URL) {
    console.error(
      '[client ambient-transaction conformance] TEST_DATABASE_URL not set — Postgres battery skipped; SQLite battery ran.'
    );
  }
});

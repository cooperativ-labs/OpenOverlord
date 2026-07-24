import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listChangedFilesForReview } from './changes.js';
import { createProject } from './projects.js';
import { recordWork } from './protocol.js';
import { createSeededServiceContext } from './test-helpers.js';
import { DELIVERY_COMPOSE_JOB_TYPE } from './worker-jobs.js';

async function setup() {
  return createSeededServiceContext({ source: 'cli' });
}

describe('recordWork (record completed chat work as a review mission)', () => {
  it('creates a review mission with one completed objective and a delivery', async () => {
    const { db, ctx } = await setup();
    const project = await createProject({ ctx, name: 'Record Basic' });

    const { mission, deliveryId } = await recordWork({
      ctx,
      projectId: project.id,
      objective: 'Build the widget the user asked for.',
      summary: 'Added the widget and wired it up.',
      changeRationales: [
        {
          filePath: 'src/widget.ts',
          label: 'Add widget',
          summary: 'New widget module.',
          why: 'User asked for a widget.',
          impact: 'Widget renders.'
        }
      ]
    });

    const missionRow = (await db.get(`SELECT status_type FROM missions WHERE id = ?`, [
      mission.id
    ])) as { status_type: string } | undefined;
    assert.equal(missionRow?.status_type, 'review');

    const objectiveRow = (await db.get(`SELECT state FROM objectives WHERE mission_id = ?`, [
      mission.id
    ])) as { state: string } | undefined;
    assert.ok(objectiveRow, 'objective exists');

    const delivery = (await db.get(`SELECT id, session_id FROM deliveries WHERE id = ?`, [
      deliveryId
    ])) as { id: string; session_id: string | null } | undefined;
    assert.ok(delivery, 'delivery row exists');
    assert.equal(delivery?.session_id, null, 'record-work delivery has no session');

    await db.close();
  });

  it('populates changed_files from rationale paths so the review panel shows them covered', async () => {
    const { db, ctx } = await setup();
    const project = await createProject({ ctx, name: 'Record Coverage' });

    const { mission } = await recordWork({
      ctx,
      projectId: project.id,
      objective: 'Ship the feature.',
      summary: 'Shipped it.',
      changeRationales: [
        {
          filePath: 'src/a.ts',
          label: 'A',
          summary: 'Changed A.',
          why: 'Because A.',
          impact: 'A works.'
        }
      ],
      // An extra touched file with no rationale surfaces as missing_rationale.
      changedFiles: [{ filePath: 'src/b.ts', vcsStatus: 'M' }]
    });

    const files = await listChangedFilesForReview({
      ctx,
      missionId: mission.id,
      includeCurrent: false
    });
    const byPath = new Map(files.map(file => [file.filePath, file]));

    assert.equal(byPath.get('src/a.ts')?.coverage, 'covered');
    assert.equal(byPath.get('src/b.ts')?.coverage, 'missing_rationale');
    assert.equal(byPath.get('src/b.ts')?.vcsStatus, 'M');

    await db.close();
  });

  it('enqueues the Gemini delivery compose job in the same transaction', async () => {
    const { db, ctx } = await setup();
    const project = await createProject({ ctx, name: 'Record Compose' });

    const { deliveryId } = await recordWork({
      ctx,
      projectId: project.id,
      objective: 'Do the thing.',
      summary: 'Did the thing.'
    });

    const job = (await db.get(
      `SELECT status FROM worker_jobs
         WHERE type = ? AND json_extract(payload_json, '$.deliveryId') = ?`,
      [DELIVERY_COMPOSE_JOB_TYPE, deliveryId]
    )) as { status: string } | undefined;
    assert.ok(job, 'a compose job was enqueued for the record-work delivery');
    assert.equal(job?.status, 'queued');

    await db.close();
  });
});

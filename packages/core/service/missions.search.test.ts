import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ServiceContext } from './context.js';
import { createMissionWithObjectives, searchMissions } from './missions.js';
import { createProject } from './projects.js';
import { createSeededServiceContext } from './test-helpers.js';
import { newId, nowIso } from './util.js';

async function setup(): Promise<{ ctx: ServiceContext; projectId: string }> {
  const { ctx } = await createSeededServiceContext({ source: 'cli' });
  const project = await createProject({ ctx, name: 'Search Project' });
  return { ctx, projectId: project.id };
}

async function recordEvent(
  ctx: ServiceContext,
  missionId: string,
  projectId: string,
  summary: string
): Promise<void> {
  await ctx.db.run(
    `INSERT INTO mission_events (
         id, workspace_id, project_id, mission_id, type, summary, source, created_at
       ) VALUES (?, ?, ?, ?, 'update', ?, 'cli', ?)`,
    [newId(), ctx.workspace.id, projectId, missionId, summary, nowIso()]
  );
}

describe('searchMissions full-text ranking', () => {
  it('matches on mission title, objective body, and event summary', async () => {
    const { ctx, projectId } = await setup();

    const titled = await createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Zylophonics dashboard rewrite',
      objectives: [{ objective: 'Plain unrelated work' }]
    });
    const viaObjective = await createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Generic mission two',
      objectives: [{ objective: 'Investigate the quarkbarrel ingestion pipeline' }]
    });
    const viaEvent = await createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Generic mission three',
      objectives: [{ objective: 'Some baseline task' }]
    });
    await recordEvent(
      ctx,
      viaEvent.mission.id,
      projectId,
      'Agent noted a flux capacitor regression in logs'
    );

    assert.deepEqual(
      (await searchMissions({ ctx, query: 'zylophonics' })).map(t => t.id),
      [titled.mission.id]
    );
    assert.deepEqual(
      (await searchMissions({ ctx, query: 'quarkbarrel' })).map(t => t.id),
      [viaObjective.mission.id]
    );
    assert.deepEqual(
      (await searchMissions({ ctx, query: 'capacitor' })).map(t => t.id),
      [viaEvent.mission.id]
    );

    await ctx.db.close();
  });

  it('supports prefix matching on partial words', async () => {
    const { ctx, projectId } = await setup();
    const mission = await createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Implement efficient mission search',
      objectives: [{ objective: 'baseline' }]
    });

    assert.deepEqual(
      (await searchMissions({ ctx, query: 'effic' })).map(t => t.id),
      [mission.mission.id]
    );
    await ctx.db.close();
  });

  it('ranks a title match above an event-only match for the same term', async () => {
    const { ctx, projectId } = await setup();
    const inTitle = await createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Moonbeam telemetry overhaul',
      objectives: [{ objective: 'baseline one' }]
    });
    const inEvent = await createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Logging cleanup',
      objectives: [{ objective: 'baseline two' }]
    });
    await recordEvent(
      ctx,
      inEvent.mission.id,
      projectId,
      'Discussed moonbeam edge cases with the team'
    );

    const ranked = (await searchMissions({ ctx, query: 'moonbeam' })).map(t => t.id);
    assert.deepEqual(ranked, [inTitle.mission.id, inEvent.mission.id]);
    await ctx.db.close();
  });

  it('drops soft-deleted missions from results', async () => {
    const { ctx, projectId } = await setup();
    const mission = await createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Krypton storage migration',
      objectives: [{ objective: 'baseline' }]
    });

    assert.equal((await searchMissions({ ctx, query: 'krypton' })).length, 1);

    await ctx.db.run(`UPDATE missions SET deleted_at = ?, revision = revision + 1 WHERE id = ?`, [
      nowIso(),
      mission.mission.id
    ]);

    assert.equal((await searchMissions({ ctx, query: 'krypton' })).length, 0);
    // Soft-deleting the mission removes all of its indexed documents.
    const remaining = (await ctx.db.get(
      `SELECT COUNT(*) AS c FROM search_documents WHERE mission_id = ?`,
      [mission.mission.id]
    )) as { c: number };
    assert.equal(remaining.c, 0);
    await ctx.db.close();
  });

  it('falls back to a recency listing when the query has no usable terms', async () => {
    const { ctx, projectId } = await setup();
    const older = await createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Older mission',
      objectives: [{ objective: 'baseline' }]
    });
    const newer = await createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Newer mission',
      objectives: [{ objective: 'baseline' }]
    });
    // Touch the newer mission so it sorts first by updated_at.
    await ctx.db.run(`UPDATE missions SET updated_at = ? WHERE id = ?`, [
      '2999-01-01T00:00:00.000Z',
      newer.mission.id
    ]);

    const results = await searchMissions({ ctx, query: '   ' });
    assert.ok(results.length >= 2);
    assert.equal(results[0]?.id, newer.mission.id);
    assert.ok(results.some(t => t.id === older.mission.id));
    await ctx.db.close();
  });
});

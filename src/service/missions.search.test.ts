import { openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext, type ServiceContext } from './context.js';
import { createMissionWithObjectives, searchMissions } from './missions.js';
import { createProject } from './projects.js';
import { newId, nowIso } from './util.js';

function setup(): { ctx: ServiceContext; projectId: string } {
  const db = openInMemoryDatabase();
  const ctx = createServiceContext({ db, source: 'cli' });
  const project = createProject({ ctx, name: 'Search Project' });
  return { ctx, projectId: project.id };
}

function recordEvent(
  ctx: ServiceContext,
  missionId: string,
  projectId: string,
  summary: string
): void {
  ctx.db
    .prepare(
      `INSERT INTO mission_events (
         id, workspace_id, project_id, mission_id, type, summary, source, created_at
       ) VALUES (?, ?, ?, ?, 'update', ?, 'cli', ?)`
    )
    .run(newId(), ctx.workspace.id, projectId, missionId, summary, nowIso());
}

describe('searchMissions full-text ranking', () => {
  it('matches on mission title, objective body, and event summary', () => {
    const { ctx, projectId } = setup();

    const titled = createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Zylophonics dashboard rewrite',
      objectives: [{ objective: 'Plain unrelated work' }]
    });
    const viaObjective = createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Generic mission two',
      objectives: [{ objective: 'Investigate the quarkbarrel ingestion pipeline' }]
    });
    const viaEvent = createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Generic mission three',
      objectives: [{ objective: 'Some baseline task' }]
    });
    recordEvent(
      ctx,
      viaEvent.mission.id,
      projectId,
      'Agent noted a flux capacitor regression in logs'
    );

    assert.deepEqual(
      searchMissions({ ctx, query: 'zylophonics' }).map(t => t.id),
      [titled.mission.id]
    );
    assert.deepEqual(
      searchMissions({ ctx, query: 'quarkbarrel' }).map(t => t.id),
      [viaObjective.mission.id]
    );
    assert.deepEqual(
      searchMissions({ ctx, query: 'capacitor' }).map(t => t.id),
      [viaEvent.mission.id]
    );

    ctx.db.close();
  });

  it('supports prefix matching on partial words', () => {
    const { ctx, projectId } = setup();
    const mission = createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Implement efficient mission search',
      objectives: [{ objective: 'baseline' }]
    });

    assert.deepEqual(
      searchMissions({ ctx, query: 'effic' }).map(t => t.id),
      [mission.mission.id]
    );
    ctx.db.close();
  });

  it('ranks a title match above an event-only match for the same term', () => {
    const { ctx, projectId } = setup();
    const inTitle = createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Moonbeam telemetry overhaul',
      objectives: [{ objective: 'baseline one' }]
    });
    const inEvent = createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Logging cleanup',
      objectives: [{ objective: 'baseline two' }]
    });
    recordEvent(ctx, inEvent.mission.id, projectId, 'Discussed moonbeam edge cases with the team');

    const ranked = searchMissions({ ctx, query: 'moonbeam' }).map(t => t.id);
    assert.deepEqual(ranked, [inTitle.mission.id, inEvent.mission.id]);
    ctx.db.close();
  });

  it('drops soft-deleted missions from results', () => {
    const { ctx, projectId } = setup();
    const mission = createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Krypton storage migration',
      objectives: [{ objective: 'baseline' }]
    });

    assert.equal(searchMissions({ ctx, query: 'krypton' }).length, 1);

    ctx.db
      .prepare(`UPDATE missions SET deleted_at = ?, revision = revision + 1 WHERE id = ?`)
      .run(nowIso(), mission.mission.id);

    assert.equal(searchMissions({ ctx, query: 'krypton' }).length, 0);
    // Soft-deleting the mission removes all of its indexed documents.
    const remaining = ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM search_documents WHERE mission_id = ?`)
      .get(mission.mission.id) as { c: number };
    assert.equal(remaining.c, 0);
    ctx.db.close();
  });

  it('falls back to a recency listing when the query has no usable terms', () => {
    const { ctx, projectId } = setup();
    const older = createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Older mission',
      objectives: [{ objective: 'baseline' }]
    });
    const newer = createMissionWithObjectives({
      ctx,
      projectId,
      title: 'Newer mission',
      objectives: [{ objective: 'baseline' }]
    });
    // Touch the newer mission so it sorts first by updated_at.
    ctx.db
      .prepare(`UPDATE missions SET updated_at = ? WHERE id = ?`)
      .run('2999-01-01T00:00:00.000Z', newer.mission.id);

    const results = searchMissions({ ctx, query: '   ' });
    assert.ok(results.length >= 2);
    assert.equal(results[0]?.id, newer.mission.id);
    assert.ok(results.some(t => t.id === older.mission.id));
    ctx.db.close();
  });
});

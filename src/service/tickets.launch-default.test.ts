import { openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.js';
import { createProject } from './projects.js';
import { seedServiceOperator } from './test-helpers.js';
import { createTicketWithObjectives } from './tickets.js';
import { newId, nowIso } from './util.js';

function setup() {
  const db = openInMemoryDatabase();
  // The launch preference is keyed by workspace user, so the context needs a real
  // actor for the defaulting to resolve a stored selection.
  seedServiceOperator({ db });
  const ctx = createServiceContext({ db, source: 'cli' });
  return { db, ctx };
}

function setLaunchPreference(
  ctx: ReturnType<typeof createServiceContext>,
  projectId: string,
  preference: {
    selectedAgent: string;
    selectedModel?: string | null;
    selectedReasoningEffort?: string | null;
  }
): void {
  const now = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO project_user_preferences
         (id, workspace_id, project_id, workspace_user_id, preferences_json,
          created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      newId(),
      ctx.workspace.id,
      projectId,
      ctx.actorWorkspaceUserId,
      JSON.stringify({
        launchPreference: {
          selectedAgent: preference.selectedAgent,
          selectedModel: preference.selectedModel ?? null,
          selectedReasoningEffort: preference.selectedReasoningEffort ?? null
        }
      }),
      now,
      now
    );
}

function agentOf(
  ctx: ReturnType<typeof createServiceContext>,
  objectiveId: string
): { assigned_agent: string | null; model: string | null; reasoning_effort: string | null } {
  return ctx.db
    .prepare(`SELECT assigned_agent, model, reasoning_effort FROM objectives WHERE id = ?`)
    .get(objectiveId) as {
    assigned_agent: string | null;
    model: string | null;
    reasoning_effort: string | null;
  };
}

describe('objective creation agent defaulting', () => {
  it('stamps draft and future objectives with the project last-used agent', () => {
    const { db, ctx } = setup();
    const project = createProject({ ctx, name: 'Default Agent' });
    setLaunchPreference(ctx, project.id, {
      selectedAgent: 'claude',
      selectedModel: 'claude-opus-4-8',
      selectedReasoningEffort: 'high'
    });

    const { objectives } = createTicketWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Draft step' }, { objective: 'Future step' }]
    });

    // Both the draft (index 0) and future (index 1) slots record the agent so the
    // launch button and any later auto-advance read a populated db, never null.
    for (const objective of objectives) {
      const stored = agentOf(ctx, objective.id);
      assert.equal(stored.assigned_agent, 'claude');
      assert.equal(stored.model, 'claude-opus-4-8');
      assert.equal(stored.reasoning_effort, 'high');
    }

    db.close();
  });

  it('leaves the agent unset when the project has no launch preference', () => {
    const { db, ctx } = setup();
    const project = createProject({ ctx, name: 'No Preference' });

    const { objectives } = createTicketWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Draft step' }]
    });

    const stored = agentOf(ctx, objectives[0]?.id as string);
    assert.equal(stored.assigned_agent, null);

    db.close();
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decideAutoAdvanceAfterDelivery,
  deriveObjectiveLifecycleView,
  manageObjectiveLifecycle,
  type ObjectiveLifecycleObjective,
  planEnsureDraftSlot,
  validateObjectiveLifecycle
} from './index.js';

function objective(
  overrides: Partial<ObjectiveLifecycleObjective> & Pick<ObjectiveLifecycleObjective, 'id'>
): ObjectiveLifecycleObjective {
  return {
    position: 0,
    state: 'future',
    instructionText: 'Do work',
    autoAdvance: false,
    assignedAgent: null,
    ...overrides
  };
}

describe('objective lifecycle rules', () => {
  it('derives the ordered UI groups without embedding rules in the component', () => {
    const view = deriveObjectiveLifecycleView([
      objective({ id: 'future-1', position: 3, state: 'future' }),
      objective({ id: 'done', position: 0, state: 'complete' }),
      objective({ id: 'next', position: 2, state: 'submitted' }),
      objective({ id: 'active', position: 1, state: 'executing' })
    ]);

    assert.deepEqual(
      view.orderedObjectives.map(item => item.id),
      ['done', 'active', 'next', 'future-1']
    );
    assert.deepEqual(
      view.executedObjectives.map(item => item.id),
      ['done', 'active']
    );
    assert.deepEqual(
      view.editableObjectives.map(item => item.id),
      ['next']
    );
    assert.deepEqual(
      view.futureObjectives.map(item => item.id),
      ['future-1']
    );
  });

  it('reports lifecycle invariant violations', () => {
    const violations = validateObjectiveLifecycle([
      objective({ id: 'draft-1', position: 0, state: 'draft' }),
      objective({ id: 'draft-2', position: 0, state: 'draft' }),
      objective({ id: 'executing', position: 2, state: 'executing' }),
      objective({ id: 'pending', position: 3, state: 'pending_delivery' }),
      objective({ id: 'blank', position: 4, state: 'complete', instructionText: '   ' })
    ]);

    assert.deepEqual(
      violations.map(violation => violation.code),
      [
        'multiple_drafts',
        'multiple_active_objectives',
        'duplicate_position',
        'blank_instruction_after_draft'
      ]
    );
  });

  it('plans unconditional draft-slot refill independently from auto-advance', () => {
    assert.deepEqual(
      planEnsureDraftSlot([
        objective({ id: 'done', position: 0, state: 'complete', assignedAgent: 'codex' }),
        objective({ id: 'future', position: 1, state: 'future' })
      ]),
      { action: 'promote_future', objectiveId: 'future' }
    );

    assert.deepEqual(
      planEnsureDraftSlot(
        [objective({ id: 'done', position: 0, state: 'complete', assignedAgent: 'codex' })],
        { previousObjectiveId: 'done' }
      ),
      { action: 'create_blank_draft', assignedAgent: 'codex' }
    );
  });

  it('keeps pre-attach submitted or launching objectives in the next-up slot', () => {
    assert.deepEqual(
      planEnsureDraftSlot([objective({ id: 'queued', position: 0, state: 'submitted' })]),
      { action: 'none', reason: 'next_up_still_launching' }
    );
    assert.deepEqual(
      planEnsureDraftSlot([objective({ id: 'launching', position: 0, state: 'launching' })]),
      { action: 'none', reason: 'next_up_still_launching' }
    );
  });

  it('decides post-delivery auto-advance policy for the next draft', () => {
    assert.deepEqual(
      decideAutoAdvanceAfterDelivery([
        objective({ id: 'done', position: 0, state: 'complete' }),
        objective({
          id: 'next',
          position: 1,
          state: 'draft',
          autoAdvance: true,
          assignedAgent: 'codex'
        })
      ]),
      { action: 'queue_launch', objectiveId: 'next', idempotencyKey: 'auto_advance:next' }
    );

    assert.deepEqual(
      decideAutoAdvanceAfterDelivery([
        objective({ id: 'next', position: 0, state: 'draft', autoAdvance: false })
      ]),
      {
        action: 'await_approval',
        objectiveId: 'next',
        reason: 'Next objective is waiting for approval.'
      }
    );
  });

  it('exposes a registry-friendly automation output', () => {
    const output = manageObjectiveLifecycle({
      objectives: [
        objective({ id: 'done', position: 0, state: 'complete' }),
        objective({ id: 'next', position: 1, state: 'draft' }),
        objective({ id: 'future', position: 2, state: 'future' })
      ],
      planAutoAdvance: true
    });

    assert.deepEqual(output.orderedObjectiveIds, ['done', 'next', 'future']);
    assert.deepEqual(output.editableObjectiveIds, ['next']);
    assert.deepEqual(output.futureObjectiveIds, ['future']);
    assert.equal(output.autoAdvanceDecision?.action, 'await_approval');
  });
});

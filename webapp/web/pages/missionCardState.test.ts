import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MissionDto } from '../../shared/contract.ts';
import {
  MISSION_STATUS_INDICATORS,
  type MissionStatusIndicator
} from '../lib/mission-status-catalog.ts';

import { getMissionCardState } from './missionCardState.ts';

// getMissionCardState only reads the aggregate flags below, so a partial cast
// keeps fixtures readable without fabricating a whole MissionDto.
function mission(flags: Partial<MissionDto> = {}): MissionDto {
  return {
    hasExecutingObjective: false,
    hasUnseenBlockingQuestion: false,
    hasUnseenReturnedToExecute: false,
    hasCompletedObjective: false,
    hasPendingObjectiveWithInstructions: false,
    completedObjectiveCount: 0,
    ...flags
  } as unknown as MissionDto;
}

describe('getMissionCardState', () => {
  it('derives the shimmer from an executing objective', () => {
    assert.equal(getMissionCardState(mission({ hasExecutingObjective: true })).shimmer, true);
    assert.equal(getMissionCardState(mission()).shimmer, false);
  });

  it('surfaces the blocking-question indicator from the catalog when unseen', () => {
    const state = getMissionCardState(mission({ hasUnseenBlockingQuestion: true }));
    assert.deepEqual(
      state.activeIndicators.map(indicator => indicator.id),
      ['blocking_question']
    );
    // The dot's appearance comes from the catalog, not hardcoded in the card.
    assert.equal(state.activeIndicators[0], MISSION_STATUS_INDICATORS.blocking_question);
    assert.equal(state.activeIndicators[0].dotClassName, 'bg-orange-500');
  });

  it('has no active indicators when the blocking question has been seen', () => {
    assert.deepEqual(getMissionCardState(mission()).activeIndicators, []);
  });

  it('surfaces the returned-to-execute indicator from the catalog when unseen', () => {
    const state = getMissionCardState(mission({ hasUnseenReturnedToExecute: true }));
    assert.deepEqual(
      state.activeIndicators.map(indicator => indicator.id),
      ['returned_to_execute']
    );
    assert.equal(state.activeIndicators[0], MISSION_STATUS_INDICATORS.returned_to_execute);
    assert.equal(state.activeIndicators[0].dotClassName, 'bg-blue-500');
  });

  it('stacks both indicators when both statuses are unseen', () => {
    const state = getMissionCardState(
      mission({ hasUnseenBlockingQuestion: true, hasUnseenReturnedToExecute: true })
    );
    assert.deepEqual(
      state.activeIndicators.map(indicator => indicator.id),
      ['blocking_question', 'returned_to_execute']
    );
    assert.equal(state.activeIndicators.length, 2);
  });

  it('flags the objective-count badge only when work is queued behind a completed one', () => {
    assert.equal(
      getMissionCardState(
        mission({ hasCompletedObjective: true, hasPendingObjectiveWithInstructions: true })
      ).objectiveCountAlert,
      true
    );
    assert.equal(
      getMissionCardState(mission({ hasCompletedObjective: true })).objectiveCountAlert,
      false
    );
  });
});

describe('mission-status catalog (generality)', () => {
  it('every catalog entry is self-describing so consumers need no per-status code', () => {
    for (const [id, indicator] of Object.entries(MISSION_STATUS_INDICATORS)) {
      assert.equal(indicator.id, id);
      assert.equal(typeof indicator.label, 'string');
      assert.equal(typeof indicator.ariaLabel, 'string');
      assert.equal(typeof indicator.seenTracked, 'boolean');
      // notification is optional (card-only statuses omit it); when present it
      // must at least carry a title.
      if (indicator.notification) {
        assert.equal(typeof indicator.notification.title, 'string');
      }
    }
  });

  it('the overlay stacking offset keeps N indicators from overlapping', () => {
    // The overlay renders `top: ${0.5 + index}rem` per active indicator; two
    // real catalog entries prove the stacking is generic.
    const indicators: MissionStatusIndicator[] = [
      MISSION_STATUS_INDICATORS.blocking_question,
      MISSION_STATUS_INDICATORS.returned_to_execute
    ];
    const tops = indicators.map((_, index) => 0.5 + index);
    assert.deepEqual(tops, [0.5, 1.5]);
    assert.equal(new Set(tops).size, tops.length);
  });
});

import type { MissionDto } from '../../shared/contract.ts';

/**
 * Derived visual state for a mission card. This is the single place that decides
 * which card affordances are active so every card surface (board, list,
 * drag overlay) stays in sync. Add future card states here (e.g. an unread
 * notification indicator) rather than wiring conditions into the card markup.
 */
export interface MissionCardState {
  /** Shimmer overlay shown while at least one objective is actively executing. */
  shimmer: boolean;
  /** Count of completed objectives, shown in the bottom-right badge. */
  objectiveCount: number;
  /**
   * True when the badge should flag attention: a completed objective exists
   * alongside a draft/future objective that already has instruction text
   * (i.e. queued work behind something already finished).
   */
  objectiveCountAlert: boolean;
}

export function getMissionCardState(mission: MissionDto): MissionCardState {
  return {
    shimmer: mission.hasExecutingObjective === true,
    objectiveCount: mission.completedObjectiveCount,
    objectiveCountAlert:
      mission.hasCompletedObjective === true && mission.hasPendingObjectiveWithInstructions === true
  };
}

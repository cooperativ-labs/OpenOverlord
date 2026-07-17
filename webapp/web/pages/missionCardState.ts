import type { MissionDto } from '../../shared/contract.ts';
import {
  MISSION_STATUS_INDICATORS,
  type MissionStatusIndicator
} from '../lib/mission-status-catalog.ts';

/**
 * Derived visual state for a mission card. This is the single place that decides
 * which card affordances are active so every card surface (board, list,
 * drag overlay) stays in sync. Add future card states here (e.g. an unread
 * notification indicator) rather than wiring conditions into the card markup.
 */
export interface MissionCardState {
  /** Shimmer overlay shown while at least one objective is actively executing. */
  shimmer: boolean;
  /**
   * Active mission-status indicators (corner dots), derived by mapping the
   * mission's status flags to their entries in the mission-status catalog. The
   * overlay iterates these, so adding a status is a catalog entry + a
   * `MissionDto` flag with no overlay markup change. Currently: the orange
   * blocking-question dot, shown while the mission has a blocking question raised
   * since it was last opened and cleared once the mission is opened (server
   * stamps the "seen" time).
   */
  activeIndicators: MissionStatusIndicator[];
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
  const activeIndicators: MissionStatusIndicator[] = [];
  if (mission.hasUnseenBlockingQuestion === true) {
    activeIndicators.push(MISSION_STATUS_INDICATORS.blocking_question);
  }
  if (mission.hasUnseenReturnedToExecute === true) {
    activeIndicators.push(MISSION_STATUS_INDICATORS.returned_to_execute);
  }

  return {
    shimmer: mission.hasExecutingObjective === true,
    activeIndicators,
    objectiveCount: mission.completedObjectiveCount,
    objectiveCountAlert:
      mission.hasCompletedObjective === true && mission.hasPendingObjectiveWithInstructions === true
  };
}

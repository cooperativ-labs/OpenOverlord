/**
 * Declarative catalog of mission "status indicators" — the single source of truth
 * for what each notifiable / seen-tracked mission status *is* (its label, corner-dot
 * color, seen-tracking behavior, and native-notification profile).
 *
 * Two thin, independent pipelines consume these descriptors instead of each
 * re-encoding a per-status list:
 *   - Card indicators: {@link ../pages/missionCardState.ts#getMissionCardState}
 *     maps `MissionDto` flags to the active indicators, and
 *     {@link ../pages/MissionCardStateOverlay.tsx} renders their corner dots.
 *   - Native notifications: {@link ./native-workflow-notifications.ts} reads the
 *     `notification` profile (title + optional `soundUrl`) when firing a toast.
 *
 * Adding a new status is a catalog entry here plus (for card indicators) one
 * `MissionDto` flag and one aggregate. The catalog is intentionally a static,
 * code-owned module — statuses ship with their own rendering + sound assets, so
 * they are a closed set, not DB-configured data.
 *
 * Scope: this catalog is for *corner indicators / notifiable mission statuses*.
 * It deliberately does not model every card affordance — the executing "shimmer"
 * is an animated full-card overlay driven by live objective state, not a
 * seen-tracked corner dot, so it stays special-cased in the card state.
 */

/**
 * Identifiers for catalog statuses. Extend this union as statuses are added.
 * `'returned_to_execute'` marks missions sent back to the execute stage from
 * review/complete/blocked (see planning/feature-plans/mission-status-indicators.md).
 */
export type MissionStatusIndicatorId = 'blocking_question' | 'returned_to_execute';

export interface MissionStatusNotificationProfile {
  /** Title used for the OS/browser notification for this status. */
  title: string;
  /**
   * URL of a bundled audio asset played alongside the OS/browser toast, giving a
   * status its own "please look at me" chime. Optional: statuses without a sound
   * fall back to the platform default. Wired end-to-end through the desktop
   * bridge + browser path; concrete assets are added separately.
   */
  soundUrl?: string;
}

export interface MissionStatusIndicator {
  id: MissionStatusIndicatorId;
  /** Human-readable label (settings copy, docs). */
  label: string;
  /**
   * Tailwind color classes for the card corner dot, or `null` when this status
   * has no card indicator (notification-only).
   */
  dotClassName: string | null;
  /** `aria-label` for the corner dot. */
  ariaLabel: string;
  /**
   * When true, the indicator shows on the card until the user opens the mission,
   * then clears (a "seen" stamp is recorded server-side). When false, the status
   * is transient / notification-only and never persists as a card dot.
   */
  seenTracked: boolean;
  /** Native-notification profile; omit for card-only statuses. */
  notification?: MissionStatusNotificationProfile;
}

export const MISSION_STATUS_INDICATORS: Record<MissionStatusIndicatorId, MissionStatusIndicator> = {
  blocking_question: {
    id: 'blocking_question',
    label: 'Blocking question',
    dotClassName: 'bg-orange-500',
    ariaLabel: 'Blocking question awaiting your response',
    seenTracked: true,
    notification: {
      title: 'Blocking question'
      // soundUrl: added when the yellow-orange chime asset ships.
    }
  },
  returned_to_execute: {
    id: 'returned_to_execute',
    label: 'Returned to execute',
    dotClassName: 'bg-blue-500',
    ariaLabel: 'Mission returned to execute stage',
    seenTracked: true,
    notification: {
      title: 'Returned to execute'
      // soundUrl: added when the chime asset ships.
    }
  }
};

export function getMissionStatusIndicator(id: MissionStatusIndicatorId): MissionStatusIndicator {
  return MISSION_STATUS_INDICATORS[id];
}

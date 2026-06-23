import { cn } from '@/lib/utils';

import type { MissionCardState } from './missionCardState.ts';

/**
 * Renders the visual overlays that correspond to a mission card's derived state:
 * the executing shimmer and the bottom-right objective count badge. Future
 * states (e.g. an unread notification indicator) should be rendered here so
 * every card surface stays consistent through getMissionCardState. The host
 * card must be positioned (`relative`) and clip overflow for the overlays to
 * sit correctly.
 */
export function MissionCardStateOverlay({ state }: { state: MissionCardState }) {
  return (
    <>
      {state.shimmer ? (
        <div className="pointer-events-none absolute inset-0 animate-[shimmer_2s_linear_infinite] bg-[length:200%_100%] bg-linear-to-r from-transparent via-emerald-500/20 to-transparent" />
      ) : null}
    </>
  );
}

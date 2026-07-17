import type { MissionCardState } from './missionCardState.ts';

/**
 * Renders the visual overlays that correspond to a mission card's derived state:
 * the executing shimmer and the top-right status indicator dots. Future card
 * states should be added to the mission-status catalog + getMissionCardState so
 * every card surface stays consistent; the dots below iterate the derived
 * `activeIndicators` and need no markup change per status. The host card must be
 * positioned (`relative`) and clip overflow for the overlays to sit correctly.
 */
export function MissionCardStateOverlay({ state }: { state: MissionCardState }) {
  return (
    <>
      {state.shimmer ? (
        <div className="pointer-events-none absolute inset-0 animate-[shimmer_3s_linear_infinite] bg-size-[200%_100%] bg-linear-to-r from-transparent via-emerald-500/20 to-transparent" />
      ) : null}
      {state.activeIndicators.map((indicator, index) =>
        indicator.dotClassName ? (
          <span
            key={indicator.id}
            aria-label={indicator.ariaLabel}
            // Stack multiple dots vertically down the top-right corner so they
            // never overlap (0.5rem, 1.5rem, …).
            style={{ top: `${0.5 + index}rem` }}
            className={`pointer-events-none absolute right-2 z-10 size-2.5 rounded-full shadow-sm ring-2 ring-white dark:ring-gray-900 ${indicator.dotClassName}`}
          />
        ) : null
      )}
    </>
  );
}

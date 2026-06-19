import { cn } from '@/lib/utils';

import type { TicketCardState } from './ticketCardState.ts';

/**
 * Renders the visual overlays that correspond to a ticket card's derived state:
 * the executing shimmer and the bottom-right objective count badge. Future
 * states (e.g. an unread notification indicator) should be rendered here so
 * every card surface stays consistent through getTicketCardState. The host
 * card must be positioned (`relative`) and clip overflow for the overlays to
 * sit correctly.
 */
export function TicketCardStateOverlay({ state }: { state: TicketCardState }) {
  return (
    <>
      {state.shimmer ? (
        <div className="pointer-events-none absolute inset-0 animate-[shimmer_2s_linear_infinite] bg-[length:200%_100%] bg-linear-to-r from-transparent via-emerald-500/20 to-transparent" />
      ) : null}

    </>
  );
}

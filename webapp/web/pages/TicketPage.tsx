import { useParams } from '@tanstack/react-router';

import { TicketDrawer } from '../components/TicketDrawer.tsx';
import { TicketPanel } from '../components/TicketPanel.tsx';

export function TicketPanelRoute() {
  const { projectId, ticketId } = useParams({
    from: '/projects/$projectId/tickets/$ticketId'
  });

  return (
    <TicketDrawer>
      <TicketPanel projectId={projectId} ticketId={ticketId} />
    </TicketDrawer>
  );
}

import { Outlet, useNavigate, useParams } from '@tanstack/react-router';

import { ProjectWorkspaceErrorBoundary } from '../components/ProjectWorkspaceErrorBoundary.tsx';
import { TicketDrawer } from '../components/TicketDrawer.tsx';
import { TicketPanel } from '../components/TicketPanel.tsx';

import { MyTicketsPage } from './MyTicketsPage.tsx';

/** Layout for the My Tickets surface: the aggregate board plus the nested panel. */
export function MyTicketsShell() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <ProjectWorkspaceErrorBoundary region="board">
          <MyTicketsPage />
        </ProjectWorkspaceErrorBoundary>
      </main>
      <ProjectWorkspaceErrorBoundary region="ticket panel">
        <Outlet />
      </ProjectWorkspaceErrorBoundary>
    </div>
  );
}

/** The ticket panel opened from a My Tickets card; closes back to `/workspace`. */
export function WorkspaceTicketPanelRoute() {
  const { ticketId } = useParams({ from: '/workspace/tickets/$ticketId' });
  const navigate = useNavigate();
  return (
    <TicketDrawer>
      <TicketPanel
        projectId=""
        ticketId={ticketId}
        onClose={() => void navigate({ to: '/workspace' })}
        onProjectChanged={() =>
          void navigate({ to: '/workspace/tickets/$ticketId', params: { ticketId } })
        }
      />
    </TicketDrawer>
  );
}

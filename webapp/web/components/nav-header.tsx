import { useParams } from '@tanstack/react-router';
import { Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { NewTicketModal } from '@/components/NewTicketModal.tsx';
import { Button } from '@/components/ui/button';
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { DRAG_REGION, getDesktopChrome, NO_DRAG_REGION } from '@/lib/desktop-chrome';
import { useProjects } from '@/lib/queries.ts';

import { TicketSearch } from './nav-header/TicketSearch.tsx';

/**
 * Top bar shown above the page content on every route. Holds the sidebar toggle
 * and the global ticket search, which is wired into the shared search index via
 * GET /api/tickets/search.
 *
 * Inside the desktop shell the native title bar is gone, so the bar doubles as
 * the window-drag region: the strip itself drags, while the interactive controls
 * opt out so they stay clickable.
 */
export function NavHeader() {
  const { isDesktop, isMacDesktop } = getDesktopChrome();
  const { state } = useSidebar();
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  const projectsQ = useProjects();
  const [isNewTicketOpen, setIsNewTicketOpen] = useState(false);
  const hasProjects = (projectsQ.data?.length ?? 0) > 0;
  const handleHardRefresh = () => {
    window.location.reload();
  };

  return (
    <header
      className={
        isMacDesktop
          ? 'flex h-11 shrink-0 flex-row items-center justify-between gap-2 border-b border-border bg-background px-4 py-1 text-foreground'
          : 'flex h-11 shrink-0 flex-row items-center justify-between gap-2 border-b border-border bg-sidebar px-4 py-1 text-sidebar-foreground'
      }
      style={isDesktop ? DRAG_REGION : undefined}
    >
      <div
        className="flex shrink-0 items-center gap-1"
        style={isDesktop ? NO_DRAG_REGION : undefined}
      >
        <SidebarTrigger className={isMacDesktop && state === 'collapsed' ? 'ml-5' : undefined} />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleHardRefresh}
          title="Refresh page"
          aria-label="Refresh page"
        >
          <RefreshCw />
        </Button>
      </div>
      <div className="flex min-w-0 flex-1 justify-center px-2">
        <div className="w-full min-w-0 max-w-xl" style={isDesktop ? NO_DRAG_REGION : undefined}>
          <TicketSearch />
        </div>
      </div>
      <div
        className="flex shrink-0 items-center gap-2"
        style={isDesktop ? NO_DRAG_REGION : undefined}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setIsNewTicketOpen(true)}
          disabled={!hasProjects}
        >
          <Plus />
          New ticket
        </Button>
      </div>
      <NewTicketModal
        open={isNewTicketOpen}
        onClose={() => setIsNewTicketOpen(false)}
        defaultProjectId={projectId ?? null}
      />
    </header>
  );
}

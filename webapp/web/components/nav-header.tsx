import { SidebarTrigger } from '@/components/ui/sidebar';

import { TicketSearch } from './nav-header/TicketSearch.tsx';

/**
 * Top bar shown above the page content on every route. Holds the sidebar toggle
 * and the global ticket search, which is wired into the shared search index via
 * GET /api/tickets/search.
 */
export function NavHeader() {
  return (
    <header className="flex h-11 shrink-0 flex-row items-center justify-between gap-2 border-b border-border bg-sidebar px-4 py-1 text-sidebar-foreground">
      <div className="flex shrink-0 items-center gap-1">
        <SidebarTrigger />
      </div>
      <div className="flex min-w-0 flex-1 justify-center px-2">
        <div className="w-full min-w-0 max-w-xl">
          <TicketSearch />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3" />
    </header>
  );
}

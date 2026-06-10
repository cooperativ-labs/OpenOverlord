import { Globe } from 'lucide-react';

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { useMeta } from '@/lib/queries';

export function WorkspaceSwitcher() {
  const meta = useMeta();
  const workspaceName = meta.data?.workspace.name ?? 'Workspace';

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" className="cursor-default hover:bg-transparent">
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <Globe className="size-4" />
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{workspaceName}</span>
            <span className="truncate text-xs text-muted-foreground">Workspace</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

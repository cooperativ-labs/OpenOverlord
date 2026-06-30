import { MoreHorizontal } from 'lucide-react';
import * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';

type SidebarLinkMenuButtonProps = {
  isActive?: boolean;
  tooltip?: string;
  link: React.ReactElement;
  children: React.ReactNode;
  menuContent: React.ReactNode;
  menuLabel?: string;
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  menuDisabled?: boolean;
  buttonClassName?: string;
};

export function SidebarLinkMenuButton({
  isActive = false,
  tooltip,
  link,
  children,
  menuContent,
  menuLabel = 'Options',
  menuOpen,
  onMenuOpenChange,
  menuDisabled = false,
  buttonClassName
}: SidebarLinkMenuButtonProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = menuOpen ?? internalOpen;
  const setOpen = onMenuOpenChange ?? setInternalOpen;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={link}
        isActive={isActive}
        tooltip={tooltip}
        className={buttonClassName}
      >
        {children}
      </SidebarMenuButton>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger render={<SidebarMenuAction showOnHover disabled={menuDisabled} />}>
          <MoreHorizontal />
          <span className="sr-only">{menuLabel}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-auto rounded-lg">
          {menuContent}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

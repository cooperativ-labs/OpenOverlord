import type { DraggableAttributes } from '@dnd-kit/core';
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import { GripVertical, MoreHorizontal } from 'lucide-react';
import * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

/** Drag-handle wiring for a `useSortable` item's activator node. */
type DragHandleProps = {
  ref: (node: HTMLElement | null) => void;
  attributes: DraggableAttributes;
  listeners: SyntheticListenerMap | undefined;
  label: string;
  disabled?: boolean;
};

type SidebarLinkMenuButtonProps = {
  isActive?: boolean;
  tooltip?: string;
  link: React.ReactElement;
  children: React.ReactNode;
  menuContent: React.ReactNode;
  menuLabel?: string;
  menuSide?: 'left' | 'right';
  dragHandleSide?: 'left' | 'right';
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  menuDisabled?: boolean;
  buttonClassName?: string;
  /** Applied to the underlying `<li>` when this item participates in a dnd-kit sortable list. */
  itemRef?: (node: HTMLElement | null) => void;
  itemStyle?: React.CSSProperties;
  isDragging?: boolean;
  dragHandle?: DragHandleProps;
};

export function SidebarLinkMenuButton({
  isActive = false,
  tooltip,
  link,
  children,
  menuContent,
  menuLabel = 'Options',
  menuSide = 'right',
  dragHandleSide = 'right',
  menuOpen,
  onMenuOpenChange,
  menuDisabled = false,
  buttonClassName,
  itemRef,
  itemStyle,
  isDragging = false,
  dragHandle
}: SidebarLinkMenuButtonProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = menuOpen ?? internalOpen;
  const setOpen = onMenuOpenChange ?? setInternalOpen;

  return (
    <SidebarMenuItem
      ref={itemRef}
      style={itemStyle}
      className={cn(isDragging && 'z-10 opacity-50')}
    >
      <SidebarMenuButton
        render={link}
        isActive={isActive}
        tooltip={tooltip}
        className={cn(
          dragHandle && dragHandleSide === 'right' && 'group-has-data-[sidebar=menu-action]/menu-item:pr-14',
          buttonClassName
        )}
      >
        {children}
      </SidebarMenuButton>
      {dragHandle ? (
        <button
          type="button"
          ref={dragHandle.ref}
          aria-label={dragHandle.label}
          disabled={dragHandle.disabled}
          className={cn(
            'absolute top-1.5 flex aspect-square w-5 touch-none items-center justify-center rounded-md text-sidebar-foreground/40 opacity-0 outline-hidden transition-opacity group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden disabled:cursor-not-allowed disabled:opacity-40 md:cursor-grab md:active:cursor-grabbing [&>svg]:size-4',
            dragHandleSide === 'left' ? 'left-2' : menuSide === 'left' ? 'right-1' : 'right-7'
          )}
          {...dragHandle.attributes}
          {...dragHandle.listeners}
        >
          <GripVertical />
        </button>
      ) : null}
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction
              showOnHover
              disabled={menuDisabled}
              className={menuSide === 'left' ? 'left-0.5 right-auto' : undefined}
            />
          }
        >
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

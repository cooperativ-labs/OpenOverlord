import { X } from 'lucide-react';
import type { ElementType, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

import { SidebarFooter } from '../ui/sidebar';

export type SettingsNavItem = {
  name: string;
  icon: ElementType;
};

export type SettingsNavGroup = {
  label?: string;
  items: SettingsNavItem[];
};

type SettingsDialogShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  breadcrumbRoot?: string;
  navGroups: SettingsNavGroup[];
  activeNav: string;
  onActiveNavChange: (name: string) => void;
  showClose?: boolean;
  sidebarFooter?: ReactNode;
  children: ReactNode;
};

export function SettingsDialogShell({
  open,
  onOpenChange,
  title,
  description,
  breadcrumbRoot,
  navGroups,
  activeNav,
  onActiveNavChange,
  showClose = false,
  sidebarFooter,
  children
}: SettingsDialogShellProps) {
  const flatNavItems = navGroups.flatMap(group => group.items);
  const activeNavItem = flatNavItems.find(item => item.name === activeNav);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="h-dvh max-h-dvh w-full max-w-full overflow-hidden p-0 sm:max-w-full md:h-auto md:max-h-[80%] md:max-w-[900px] lg:max-w-[1000px]"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>

        <div className="flex items-start">
          <aside className="hidden h-full w-52 shrink-0 flex-col border-r border-border bg-muted/30 md:flex">
            <nav className="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
              {navGroups.map((group, index) => (
                <div key={group.label ?? `group-${index}`} className="space-y-1">
                  {group.label ? (
                    <p className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {group.label}
                    </p>
                  ) : null}
                  <ul className="space-y-0.5">
                    {group.items.map(item => {
                      const Icon = item.icon;
                      const isActive = item.name === activeNav;
                      return (
                        <li key={item.name}>
                          <button
                            type="button"
                            onClick={() => onActiveNavChange(item.name)}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                              isActive
                                ? 'bg-secondary text-foreground'
                                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                            )}
                          >
                            <Icon className="size-4 shrink-0" />
                            <span>{item.name}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>
            {sidebarFooter ? <SidebarFooter> {sidebarFooter}</SidebarFooter> : null}
          </aside>

          <main className="flex h-dvh min-w-0 flex-1 flex-col overflow-hidden md:max-h-[80%]">
            <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
              <div className="flex w-full items-center md:hidden">
                <Select
                  value={activeNav}
                  onValueChange={value => {
                    if (value) onActiveNavChange(value);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>{activeNavItem?.name}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {flatNavItems.map(item => {
                      const Icon = item.icon;
                      return (
                        <SelectItem key={item.name} value={item.name}>
                          <div className="flex items-center gap-2">
                            <Icon className="size-4" />
                            <span>{item.name}</span>
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              <div className="hidden items-center gap-2 text-sm md:flex">
                <span className="text-muted-foreground">{breadcrumbRoot ?? title}</span>
                <span className="text-muted-foreground">/</span>
                <span className="font-medium">{activeNav}</span>
              </div>

              {showClose ? (
                <DialogClose
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="ml-auto shrink-0 text-muted-foreground"
                      aria-label="Close settings"
                    />
                  }
                >
                  <X className="size-5" />
                </DialogClose>
              ) : null}
            </header>

            <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">{children}</div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}

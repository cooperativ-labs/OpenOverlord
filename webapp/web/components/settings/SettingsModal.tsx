import {
  Bell,
  Code2,
  GitBranch,
  Info,
  Keyboard,
  KeyRound,
  MonitorDown,
  Palette,
  ShieldCheck,
  Terminal,
  User
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { RealtimeStatus } from '@/components/RealtimeStatus';
import { AboutPage } from '@/components/settings/AboutPage';
import { AccountPage } from '@/components/settings/AccountPage';
import { ApplicationPage } from '@/components/settings/ApplicationPage';
import { DesktopUpdatesPage } from '@/components/settings/DesktopUpdatesPage';
import { ExecutionTargetsPage } from '@/components/settings/ExecutionTargetsPage';
import { HotkeysPage } from '@/components/settings/HotkeysPage';
import { IdePage } from '@/components/settings/IdePage';
import { NotificationsPage } from '@/components/settings/NotificationsPage';
import {
  SettingsDialogShell,
  type SettingsNavGroup,
  type SettingsNavItem
} from '@/components/settings/SettingsDialogShell';
import { StatusesPage } from '@/components/settings/StatusesPage';
import { UserProfilePage } from '@/components/settings/UserProfilePage';
import { UserTokensPage } from '@/components/settings/UserTokensPage';
import { useMeta } from '@/lib/queries';

type SettingsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialNav?: SettingsNavSection;
};

const appNavItems: SettingsNavItem[] = [
  { name: 'Application', icon: Palette },
  { name: 'Notifications', icon: Bell },
  { name: 'Execution Targets', icon: Terminal },
  { name: 'Card statuses', icon: GitBranch },
  { name: 'About', icon: Info }
];

const desktopNavItem: SettingsNavItem = { name: 'Desktop', icon: MonitorDown };

const userNavItems: SettingsNavItem[] = [
  { name: 'Profile', icon: User },
  { name: 'Account', icon: ShieldCheck },
  { name: 'Tokens', icon: KeyRound },
  { name: 'Hotkeys', icon: Keyboard },
  { name: 'IDE', icon: Code2 }
];

const navItems: SettingsNavItem[] = [...userNavItems, ...appNavItems, desktopNavItem];

export type SettingsNavSection = (typeof navItems)[number]['name'];

export function SettingsModal({ open, onOpenChange, initialNav }: SettingsModalProps) {
  const [activeNav, setActiveNav] = useState<SettingsNavSection>('Profile');
  const meta = useMeta();
  const isDesktop = typeof window !== 'undefined' && window.overlord?.isDesktop === true;
  const navGroups = useMemo<SettingsNavGroup[]>(
    () => [
      { label: 'User', items: userNavItems },
      { label: 'Application', items: isDesktop ? [...appNavItems, desktopNavItem] : appNavItems }
    ],
    [isDesktop]
  );
  const availableNavItems = useMemo(() => navGroups.flatMap(group => group.items), [navGroups]);

  useEffect(() => {
    if (!open || !initialNav) return;
    if (!availableNavItems.some(item => item.name === initialNav)) return;
    setActiveNav(initialNav);
  }, [availableNavItems, open, initialNav]);

  useEffect(() => {
    if (availableNavItems.some(item => item.name === activeNav)) return;
    setActiveNav('Profile');
  }, [activeNav, availableNavItems]);

  return (
    <SettingsDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      description="Customize your settings here."
      navGroups={navGroups}
      activeNav={activeNav}
      onActiveNavChange={name => setActiveNav(name as SettingsNavSection)}
      showClose
      sidebarFooter={
        <>
          <RealtimeStatus sqlStudio={meta.data?.sqlStudio} />
          {meta.data?.databasePath && (
            <p
              className="truncate px-2 text-[10px] text-muted-foreground"
              title={meta.data.databasePath}
            >
              {meta.data.databasePath.split('/').slice(-2).join('/')}
            </p>
          )}
        </>
      }
    >
      {activeNav === 'Application' && <ApplicationPage />}
      {activeNav === 'Notifications' && <NotificationsPage />}
      {activeNav === 'Execution Targets' && <ExecutionTargetsPage />}
      {activeNav === 'Card statuses' && <StatusesPage />}
      {activeNav === 'Desktop' && <DesktopUpdatesPage />}
      {activeNav === 'Profile' && <UserProfilePage open={open} />}
      {activeNav === 'Account' && <AccountPage open={open} />}
      {activeNav === 'Tokens' && <UserTokensPage open={open} />}
      {activeNav === 'Hotkeys' && <HotkeysPage />}
      {activeNav === 'IDE' && <IdePage open={open} />}
      {activeNav === 'About' && <AboutPage open={open} />}
    </SettingsDialogShell>
  );
}

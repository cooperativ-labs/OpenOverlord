import {
  Bell,
  Cloud,
  Code2,
  GitBranch,
  Info,
  Keyboard,
  KeyRound,
  MonitorDown,
  Palette,
  Plug,
  ShieldCheck,
  Terminal,
  User
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { RealtimeStatus } from '@/components/RealtimeStatus';
import { AboutPage } from '@/components/settings/AboutPage';
import { AccountPage } from '@/components/settings/AccountPage';
import { ApplicationPage } from '@/components/settings/ApplicationPage';
import { BackendPage } from '@/components/settings/BackendPage';
import { DesktopUpdatesPage } from '@/components/settings/DesktopUpdatesPage';
import { ExecutionTargetsPage } from '@/components/settings/ExecutionTargetsPage';
import { HotkeysPage } from '@/components/settings/HotkeysPage';
import { IdePage } from '@/components/settings/IdePage';
import { IntegrationsPage } from '@/components/settings/IntegrationsPage';
import { NotificationsPage } from '@/components/settings/NotificationsPage';
import {
  SettingsDialogShell,
  type SettingsNavGroup,
  type SettingsNavItem
} from '@/components/settings/SettingsDialogShell';
import { UserProfilePage } from '@/components/settings/UserProfilePage';
import { UserTokensPage } from '@/components/settings/UserTokensPage';
import { WorktreesPage } from '@/components/settings/WorktreesPage';
import { useMeta } from '@/lib/queries';

type SettingsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialNav?: SettingsNavSection;
};

const workflowNavItems: SettingsNavItem[] = [
  { name: 'Terminal & IDE', icon: Code2 },
  { name: 'Execution Targets', icon: Terminal },
  { name: 'Worktrees', icon: GitBranch }
];

const appNavItems: SettingsNavItem[] = [
  { name: 'Application', icon: Palette },
  { name: 'Integrations', icon: Plug },
  { name: 'Notifications', icon: Bell },
  { name: 'About', icon: Info }
];

const desktopNavItems: SettingsNavItem[] = [
  { name: 'Backend', icon: Cloud },
  { name: 'Desktop', icon: MonitorDown }
];

const userNavItems: SettingsNavItem[] = [
  { name: 'Profile', icon: User },
  { name: 'Account', icon: ShieldCheck },
  { name: 'Tokens', icon: KeyRound },
  { name: 'Hotkeys', icon: Keyboard }
];

export type SettingsNavSection =
  | (typeof workflowNavItems)[number]['name']
  | (typeof appNavItems)[number]['name']
  | (typeof desktopNavItems)[number]['name']
  | (typeof userNavItems)[number]['name'];

export function SettingsModal({ open, onOpenChange, initialNav }: SettingsModalProps) {
  const [activeNav, setActiveNav] = useState<SettingsNavSection>('Profile');
  const meta = useMeta();
  const isDesktop = typeof window !== 'undefined' && window.overlord?.isDesktop === true;
  const navItems = useMemo<SettingsNavItem[]>(
    () => [
      ...workflowNavItems,
      ...userNavItems,
      ...appNavItems,
      ...(isDesktop ? desktopNavItems : [])
    ],
    [isDesktop]
  );
  const navGroups = useMemo<SettingsNavGroup[]>(
    () => [
      { label: 'Workflow', items: workflowNavItems },
      { label: 'User', items: userNavItems },
      {
        label: 'Application',
        items: isDesktop ? [...appNavItems, ...desktopNavItems] : appNavItems
      }
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
      {activeNav === 'Integrations' && <IntegrationsPage />}
      {activeNav === 'Notifications' && <NotificationsPage />}
      {activeNav === 'Execution Targets' && <ExecutionTargetsPage />}
      {activeNav === 'Worktrees' && <WorktreesPage />}
      {activeNav === 'Backend' && <BackendPage />}
      {activeNav === 'Desktop' && <DesktopUpdatesPage />}
      {activeNav === 'Profile' && <UserProfilePage open={open} />}
      {activeNav === 'Account' && <AccountPage open={open} />}
      {activeNav === 'Tokens' && <UserTokensPage open={open} />}
      {activeNav === 'Hotkeys' && <HotkeysPage />}
      {activeNav === 'Terminal & IDE' && (
        <IdePage
          open={open}
          onNavigateToExecutionTargets={() => setActiveNav('Execution Targets')}
        />
      )}
      {activeNav === 'About' && <AboutPage open={open} />}
    </SettingsDialogShell>
  );
}

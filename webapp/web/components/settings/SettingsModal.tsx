import {
  Bell,
  Cloud,
  Code2,
  GitBranch,
  Keyboard,
  KeyRound,
  MonitorDown,
  Palette,
  Plug,
  ShieldCheck,
  Terminal,
  User,
  Webhook
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { RealtimeStatus } from '@/components/RealtimeStatus';
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
import { WebhooksPage } from '@/components/settings/WebhooksPage';
import { WorktreesPage } from '@/components/settings/WorktreesPage';
import { useLocalTargetUnavailable } from '@/lib/local-target-client.ts';
import { useMeta, useProfile } from '@/lib/queries';

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
  { name: 'Hotkeys', icon: Keyboard },
  { name: 'Integrations', icon: Plug },
  { name: 'Notifications', icon: Bell }
];

// Admin-only: hidden from navGroups/navItems for non-admins (see isAdmin below);
// the underlying /api/webhooks* routes are also RBAC-gated server-side.
const adminAppNavItems: SettingsNavItem[] = [{ name: 'Webhooks', icon: Webhook }];

const desktopNavItems: SettingsNavItem[] = [
  { name: 'Backend', icon: Cloud },
  { name: 'Desktop', icon: MonitorDown }
];

const userNavItems: SettingsNavItem[] = [
  { name: 'Profile', icon: User },
  { name: 'Account', icon: ShieldCheck },
  { name: 'Tokens', icon: KeyRound }
];

export type SettingsNavSection =
  | (typeof workflowNavItems)[number]['name']
  | (typeof appNavItems)[number]['name']
  | (typeof adminAppNavItems)[number]['name']
  | (typeof desktopNavItems)[number]['name']
  | (typeof userNavItems)[number]['name'];

export function SettingsModal({ open, onOpenChange, initialNav }: SettingsModalProps) {
  const [activeNav, setActiveNav] = useState<SettingsNavSection>('Profile');
  const meta = useMeta();
  const profile = useProfile();
  const isAdmin = (profile.data?.roles ?? []).includes('ADMIN');
  const localTargetUnavailable = useLocalTargetUnavailable();
  const isDesktop = typeof window !== 'undefined' && window.overlord?.isDesktop === true;
  const resolvedAppNavItems = useMemo<SettingsNavItem[]>(
    () => [...appNavItems, ...(isAdmin ? adminAppNavItems : [])],
    [isAdmin]
  );
  const navItems = useMemo<SettingsNavItem[]>(
    () => [
      ...workflowNavItems.filter(item => !(localTargetUnavailable && item.name === 'Worktrees')),
      ...userNavItems,
      ...resolvedAppNavItems,
      ...(isDesktop ? desktopNavItems : [])
    ],
    [isDesktop, localTargetUnavailable, resolvedAppNavItems]
  );
  const navGroups = useMemo<SettingsNavGroup[]>(
    () => [
      { label: 'Workflow', items: workflowNavItems },
      { label: 'User', items: userNavItems },
      {
        label: 'Application',
        items: isDesktop ? [...resolvedAppNavItems, ...desktopNavItems] : resolvedAppNavItems
      }
    ],
    [isDesktop, resolvedAppNavItems]
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
      {activeNav === 'Webhooks' && <WebhooksPage open={open} />}
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
    </SettingsDialogShell>
  );
}

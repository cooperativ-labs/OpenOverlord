import { Info, KeyRound, MonitorDown, Palette, Terminal, User } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { AboutPage } from '@/components/settings/AboutPage';
import { ApplicationPage } from '@/components/settings/ApplicationPage';
import { DesktopUpdatesPage } from '@/components/settings/DesktopUpdatesPage';
import { ExecutionTargetsPage } from '@/components/settings/ExecutionTargetsPage';
import {
  SettingsDialogShell,
  type SettingsNavGroup,
  type SettingsNavItem
} from '@/components/settings/SettingsDialogShell';
import { UserProfilePage } from '@/components/settings/UserProfilePage';
import { UserTokensPage } from '@/components/settings/UserTokensPage';

type SettingsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialNav?: SettingsNavSection;
};

const appNavItems: SettingsNavItem[] = [
  { name: 'Application', icon: Palette },
  { name: 'Execution Targets', icon: Terminal },
  { name: 'About', icon: Info }
];

const desktopNavItem: SettingsNavItem = { name: 'Desktop', icon: MonitorDown };

const userNavItems: SettingsNavItem[] = [
  { name: 'Profile', icon: User },
  { name: 'Tokens', icon: KeyRound }
];

const navItems: SettingsNavItem[] = [...userNavItems, ...appNavItems, desktopNavItem];

export type SettingsNavSection = (typeof navItems)[number]['name'];

export function SettingsModal({ open, onOpenChange, initialNav }: SettingsModalProps) {
  const [activeNav, setActiveNav] = useState<SettingsNavSection>('Profile');
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
    >
      {activeNav === 'Application' && <ApplicationPage />}
      {activeNav === 'Execution Targets' && <ExecutionTargetsPage />}
      {activeNav === 'Desktop' && <DesktopUpdatesPage />}
      {activeNav === 'Profile' && <UserProfilePage open={open} />}
      {activeNav === 'Tokens' && <UserTokensPage open={open} />}
      {activeNav === 'About' && <AboutPage open={open} />}
    </SettingsDialogShell>
  );
}

import { Info, Palette, User } from 'lucide-react';
import { useEffect, useState } from 'react';

import { AboutPage } from '@/components/settings/AboutPage';
import { ApplicationPage } from '@/components/settings/ApplicationPage';
import { UserProfilePage } from '@/components/settings/UserProfilePage';
import {
  SettingsDialogShell,
  type SettingsNavGroup,
  type SettingsNavItem
} from '@/components/settings/SettingsDialogShell';

type SettingsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialNav?: SettingsNavSection;
};

const appNavItems: SettingsNavItem[] = [
  { name: 'Application', icon: Palette },
  { name: 'About', icon: Info }
];

const userNavItems: SettingsNavItem[] = [{ name: 'Profile', icon: User }];

const navItems: SettingsNavItem[] = [...userNavItems, ...appNavItems];

export type SettingsNavSection = (typeof navItems)[number]['name'];

const navGroups: SettingsNavGroup[] = [
  { label: 'User', items: userNavItems },
  { label: 'Application', items: appNavItems }
];

export function SettingsModal({ open, onOpenChange, initialNav }: SettingsModalProps) {
  const [activeNav, setActiveNav] = useState<SettingsNavSection>('Profile');

  useEffect(() => {
    if (!open || !initialNav) return;
    if (!navItems.some(item => item.name === initialNav)) return;
    setActiveNav(initialNav);
  }, [open, initialNav]);

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
      {activeNav === 'Profile' && <UserProfilePage open={open} />}
      {activeNav === 'About' && <AboutPage open={open} />}
    </SettingsDialogShell>
  );
}

import { Settings, Users } from 'lucide-react';
import { useEffect, useState } from 'react';

import { AdminsPage } from '@/components/organizations/organization-settings/AdminsPage';
import { GeneralPage } from '@/components/organizations/organization-settings/GeneralPage';
import {
  SettingsDialogShell,
  type SettingsNavItem
} from '@/components/settings/SettingsDialogShell.tsx';
import { useOrganizationAdminStatus } from '@/lib/hooks/use-organization-admin-status';
import { useMeta, useOrganizations } from '@/lib/queries';

const navItems: SettingsNavItem[] = [
  { name: 'General', icon: Settings },
  { name: 'Admins', icon: Users }
];

export type OrganizationSettingsNavSection = (typeof navItems)[number]['name'];

type OrganizationSettingsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string | null;
  initialNav?: OrganizationSettingsNavSection;
};

export function OrganizationSettingsModal({
  open,
  onOpenChange,
  organizationId,
  initialNav
}: OrganizationSettingsModalProps) {
  const meta = useMeta();
  const organizations = useOrganizations();
  const [activeNav, setActiveNav] = useState<OrganizationSettingsNavSection>('General');

  useEffect(() => {
    if (!open) return;
    if (initialNav && navItems.some(item => item.name === initialNav)) {
      setActiveNav(initialNav);
      return;
    }
    setActiveNav('General');
  }, [open, initialNav]);

  const organization =
    (organizations.data ?? meta.data?.organizations ?? []).find(org => org.id === organizationId) ??
    meta.data?.organization ??
    null;
  const workspaces = meta.data?.workspaces ?? [];
  const adminStatus = useOrganizationAdminStatus({
    organizationId: organization?.id ?? null,
    workspaces
  });

  return (
    <SettingsDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Organization settings"
      description="Customize your organization settings here."
      breadcrumbRoot={organization?.name ?? 'Organization settings'}
      navGroups={[{ items: navItems }]}
      activeNav={activeNav}
      onActiveNavChange={name => setActiveNav(name as OrganizationSettingsNavSection)}
    >
      {!organization ? (
        <p className="text-xs text-muted-foreground">Organization not found.</p>
      ) : adminStatus.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : !adminStatus.canView ? (
        <p className="text-xs text-muted-foreground">
          You need workspace admin access to view organization settings.
        </p>
      ) : (
        <>
          {activeNav === 'General' ? (
            <GeneralPage
              open={open}
              organization={organization}
              isOrgAdmin={adminStatus.isOrgAdmin}
              partialAdmin={adminStatus.partialAdmin}
            />
          ) : null}
          {activeNav === 'Admins' ? (
            <AdminsPage
              organization={organization}
              workspaces={workspaces}
              isOrgAdmin={adminStatus.isOrgAdmin}
              partialAdmin={adminStatus.partialAdmin}
            />
          ) : null}
        </>
      )}
    </SettingsDialogShell>
  );
}

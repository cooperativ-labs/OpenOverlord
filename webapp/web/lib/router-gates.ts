import type { Meta } from './api.ts';
import { getDesktopChrome } from './desktop-chrome.ts';
import { isOnboardingSetupPending } from './onboarding-setup.ts';

/** True when the signed-in user has no organization memberships yet. */
export function shouldShowOnboarding(
  meta: Pick<Meta, 'organizations'> | null | undefined
): boolean {
  return Boolean(meta && meta.organizations.length === 0);
}

/** True when the web user finished org creation but has not dismissed desktop/CLI setup. */
export function shouldShowOnboardingSetup(
  meta: Pick<Meta, 'organizations'> | null | undefined
): boolean {
  if (getDesktopChrome().isDesktop) return false;
  return Boolean(meta && meta.organizations.length > 0 && isOnboardingSetupPending());
}

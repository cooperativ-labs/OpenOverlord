import type { Meta } from './api.ts';

/** True when the signed-in user has no organization memberships yet. */
export function shouldShowOnboarding(
  meta: Pick<Meta, 'organizations'> | null | undefined
): boolean {
  return Boolean(meta && meta.organizations.length === 0);
}

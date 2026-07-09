const ONBOARDING_SETUP_PENDING_KEY = 'overlord-onboarding-setup-pending';

let memoryOnboardingSetupPending = false;

function readOnboardingSetupPending(): boolean {
  if (typeof sessionStorage !== 'undefined') {
    return sessionStorage.getItem(ONBOARDING_SETUP_PENDING_KEY) === '1';
  }
  return memoryOnboardingSetupPending;
}

function writeOnboardingSetupPending({ pending }: { pending: boolean }): void {
  if (typeof sessionStorage !== 'undefined') {
    if (pending) {
      sessionStorage.setItem(ONBOARDING_SETUP_PENDING_KEY, '1');
    } else {
      sessionStorage.removeItem(ONBOARDING_SETUP_PENDING_KEY);
    }
    return;
  }
  memoryOnboardingSetupPending = pending;
}

export const DESKTOP_RELEASES_URL =
  'https://github.com/cooperativ-labs/OpenOverlord/releases/latest';

export const CLI_INSTALL_COMMAND = 'npm install -g overlord-cli';

export const CLI_SETUP_COMMAND = 'ovld setup';

export const CLI_ADD_CWD_COMMAND = 'ovld add-cwd';

export const CLI_DOCS_URL = 'https://www.ovld.ai/docs/surfaces/cli';

export function buildAddCwdCommand({ projectId }: { projectId: string }): string {
  return `${CLI_ADD_CWD_COMMAND} --project-id ${projectId}`;
}

export type DesktopPlatform = 'mac' | 'windows' | 'linux' | 'unknown';

export function detectDesktopPlatform(): DesktopPlatform {
  if (typeof navigator === 'undefined') return 'unknown';

  const platform = navigator.platform?.toLowerCase() ?? '';
  const userAgent = navigator.userAgent.toLowerCase();

  if (platform.includes('mac') || userAgent.includes('mac')) return 'mac';
  if (platform.includes('win') || userAgent.includes('win')) return 'windows';
  if (platform.includes('linux') || userAgent.includes('linux')) return 'linux';
  return 'unknown';
}

export function desktopDownloadLabel({ platform }: { platform: DesktopPlatform }): string {
  switch (platform) {
    case 'mac':
      return 'Download for macOS';
    case 'windows':
      return 'Download for Windows';
    case 'linux':
      return 'Download for Linux';
    default:
      return 'Download Overlord Desktop';
  }
}

export function markOnboardingSetupPending(): void {
  writeOnboardingSetupPending({ pending: true });
}

export function clearOnboardingSetupPending(): void {
  writeOnboardingSetupPending({ pending: false });
}

export function isOnboardingSetupPending(): boolean {
  return readOnboardingSetupPending();
}

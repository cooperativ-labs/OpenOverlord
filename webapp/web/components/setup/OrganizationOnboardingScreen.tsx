import { useState } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getDesktopChrome } from '@/lib/desktop-chrome';
import {
  clearOnboardingSetupPending,
  isOnboardingSetupPending,
  markOnboardingSetupPending
} from '@/lib/onboarding-setup';

import { DesktopAppOnboardingStep } from './DesktopAppOnboardingStep';
import { OrganizationOnboardingForm } from './OrganizationOnboardingForm';

type OnboardingStep = 'organization' | 'desktop-setup';

type OrganizationOnboardingScreenProps = {
  onDesktopSetupComplete?: () => void;
};

function resolveInitialStep(): OnboardingStep {
  if (isOnboardingSetupPending()) return 'desktop-setup';
  return 'organization';
}

export function OrganizationOnboardingScreen({
  onDesktopSetupComplete
}: OrganizationOnboardingScreenProps) {
  const [step, setStep] = useState<OnboardingStep>(resolveInitialStep);

  function handleOrganizationCreated() {
    if (getDesktopChrome().isDesktop) return;
    markOnboardingSetupPending();
    setStep('desktop-setup');
  }

  function handleDesktopSetupComplete() {
    clearOnboardingSetupPending();
    onDesktopSetupComplete?.();
  }

  const isDesktopSetup = step === 'desktop-setup';

  return (
    <div className="flex h-dvh items-center justify-center overflow-y-auto bg-background px-4 py-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Step {isDesktopSetup ? 2 : 1} of 2
          </p>
          <CardTitle>{isDesktopSetup ? 'Set up on your machine' : 'Welcome to Overlord'}</CardTitle>
          <CardDescription>
            {isDesktopSetup
              ? 'Download the desktop app and install the CLI so you can connect local repositories and run agents in your terminal.'
              : 'Create your organization and first workspace. You can invite teammates and add more workspaces later.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isDesktopSetup ? (
            <DesktopAppOnboardingStep onContinue={handleDesktopSetupComplete} />
          ) : (
            <OrganizationOnboardingForm onSuccess={handleOrganizationCreated} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

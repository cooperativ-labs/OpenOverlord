import { Download, ExternalLink, MonitorDown, Terminal } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import {
  CLI_ADD_CWD_COMMAND,
  CLI_DOCS_URL,
  CLI_INSTALL_COMMAND,
  CLI_SETUP_COMMAND,
  DESKTOP_RELEASES_URL,
  desktopDownloadLabel,
  detectDesktopPlatform
} from '@/lib/onboarding-setup';
import { cn } from '@/lib/utils';

import { CopyCliCommand } from './CopyCliCommand';

type DesktopAppOnboardingStepProps = {
  onContinue: () => void;
};

export function DesktopAppOnboardingStep({ onContinue }: DesktopAppOnboardingStepProps) {
  const platform = detectDesktopPlatform();
  const downloadLabel = desktopDownloadLabel({ platform });

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-3 rounded-xl border bg-muted/30 p-4">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
            <MonitorDown className="size-4 text-primary" />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">Install the Overlord desktop app</p>
            <p className="text-xs text-muted-foreground">
              The desktop app runs your local backend, supervises agents, and is the best way to
              connect repositories on your machine.
            </p>
          </div>
        </div>
        <a
          href={DESKTOP_RELEASES_URL}
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ size: 'lg' }), 'w-full gap-2')}
        >
          <Download className="size-4" />
          {downloadLabel}
          <ExternalLink className="size-3.5 opacity-70" />
        </a>
      </div>

      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
            <Terminal className="size-4 text-primary" />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">Install and configure the CLI</p>
            <p className="text-xs text-muted-foreground">
              The CLI is required to connect a local repository, authenticate with your backend, and
              launch agents in your terminal.
            </p>
          </div>
        </div>

        <ol className="space-y-3 pl-1">
          <li className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">1. Install the CLI globally</p>
            <CopyCliCommand command={CLI_INSTALL_COMMAND} description="Requires Node.js and npm." />
          </li>
          <li className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              2. Run setup to connect the CLI
            </p>
            <CopyCliCommand
              command={CLI_SETUP_COMMAND}
              description="Configures your backend, signs you in, and installs agent connectors."
            />
          </li>
          <li className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              3. Attach a local repository to a project
            </p>
            <CopyCliCommand
              command={CLI_ADD_CWD_COMMAND}
              description="Run from the repository you want to link. Overlord will prompt you to pick a project if needed."
            />
          </li>
        </ol>

        <a
          href={CLI_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
        >
          Read the CLI docs
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div className="flex justify-end border-t pt-4">
        <Button type="button" onClick={onContinue}>
          Continue to Overlord
        </Button>
      </div>
    </div>
  );
}

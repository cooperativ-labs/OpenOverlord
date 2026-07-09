import { Terminal } from 'lucide-react';

import { CopyCliCommand } from '@/components/setup/CopyCliCommand';
import { buildAddCwdCommand, CLI_INSTALL_COMMAND, CLI_SETUP_COMMAND } from '@/lib/onboarding-setup';

type WebProjectCliLinkStepProps = {
  projectId: string;
};

export function WebProjectCliLinkStep({ projectId }: WebProjectCliLinkStepProps) {
  const addCwdCommand = buildAddCwdCommand({ projectId });

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
          <Terminal className="size-4 text-primary" />
        </div>
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">Link a local repository</p>
          <p className="text-xs text-muted-foreground">
            Install and configure the CLI, then run the link command from the checkout you want to
            associate with this project.
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
            3. Link your checkout from the repository directory
          </p>
          <CopyCliCommand
            command={addCwdCommand}
            description="Run this from the root of the repository you want to associate with this project."
          />
        </li>
      </ol>
    </div>
  );
}

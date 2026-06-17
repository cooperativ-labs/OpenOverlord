import { Check, Copy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useCopyToClipboard } from '@/lib/hooks/use-copy-to-clipboard';
import { useMeta } from '@/lib/queries';

type AboutPageProps = {
  open: boolean;
};

const WEBAPP_VERSION = '0.1.0';

export function AboutPage({ open }: AboutPageProps) {
  const meta = useMeta();
  const { copied, copy } = useCopyToClipboard();

  if (!open) return null;

  const port = meta.data?.web.port;
  const setPortCommand = port ? `ovld config set local http://127.0.0.1:${port}` : null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">About</h2>
        <p className="text-sm text-muted-foreground">
          Overlord helps you coordinate agent and human execution from one shared ticket workflow.
        </p>
      </div>

      <dl className="max-w-lg space-y-3 text-sm">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">Web app</dt>
          <dd className="font-mono text-xs">v{WEBAPP_VERSION}</dd>
        </div>
        {meta.data ? (
          <>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">Workspace</dt>
              <dd>{meta.data.workspace.name}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">Realtime</dt>
              <dd>{meta.data.capabilities.realtime ? 'Enabled' : 'Disabled'}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">Database port</dt>
              <dd className="font-mono text-xs">{meta.data.web.port}</dd>
            </div>
          </>
        ) : null}
      </dl>

      {setPortCommand ? (
        <div className="max-w-lg space-y-1.5">
          <p className="text-xs text-muted-foreground">Point the CLI at this database:</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs">
              {setPortCommand}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => copy(setPortCommand)}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Learn more at{' '}
        <a
          href="https://www.ovld.ai"
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline underline-offset-2 hover:text-foreground/80"
        >
          ovld.ai
        </a>
        . Connector setup remains CLI-first; launch defaults for this machine now live under{' '}
        Execution Targets.
      </p>
    </div>
  );
}

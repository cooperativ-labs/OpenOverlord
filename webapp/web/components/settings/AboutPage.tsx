import { useMeta } from '@/lib/queries';

type AboutPageProps = {
  open: boolean;
};

const WEBAPP_VERSION = '0.1.0';

export function AboutPage({ open }: AboutPageProps) {
  const meta = useMeta();

  if (!open) return null;

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
          </>
        ) : null}
      </dl>

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
        . Agent launch, execution targets, and connector setup remain available through the CLI.
      </p>
    </div>
  );
}

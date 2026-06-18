import { type LinkState, useRealtime } from '@/lib/realtime';

type RealtimeStatusProps = {
  sqlStudio?: { enabled: boolean; url: string | null };
};

export function RealtimeStatus({ sqlStudio }: RealtimeStatusProps) {
  const { state } = useRealtime();
  const config: Record<LinkState, { label: string; dot: string }> = {
    live: { label: 'Live', dot: 'bg-emerald-400' },
    connecting: { label: 'Connecting…', dot: 'bg-amber-400' },
    reconnecting: { label: 'Reconnecting…', dot: 'bg-amber-400 animate-pulse' }
  };
  const c = config[state];
  const sqlStudioUrl = sqlStudio?.enabled ? sqlStudio.url : null;
  const canOpenSqlStudio = Boolean(sqlStudioUrl);

  const content = (
    <>
      <span className={`h-2 w-2 rounded-full ${c.dot}`} />
      {c.label}
    </>
  );

  if (canOpenSqlStudio) {
    return (
      <button
        type="button"
        className="flex items-center gap-2 px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
        title="Open SQL Studio"
        onClick={() => window.open(sqlStudioUrl ?? undefined, '_blank', 'noopener,noreferrer')}
      >
        {content}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">{content}</div>
  );
}

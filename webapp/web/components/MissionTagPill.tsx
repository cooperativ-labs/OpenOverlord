import { Tag, X } from 'lucide-react';

export function MissionTagPill({
  label,
  onRemove,
  disabled
}: {
  label: string;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-muted/80 px-2.5 text-xs font-semibold text-foreground">
      <Tag className="h-3 w-3 shrink-0 stroke-[1.75]" aria-hidden />
      <span className="truncate">{label}</span>
      {onRemove ? (
        <button
          type="button"
          className="inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
          aria-label={`Remove ${label} tag`}
          disabled={disabled}
          onClick={onRemove}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  );
}

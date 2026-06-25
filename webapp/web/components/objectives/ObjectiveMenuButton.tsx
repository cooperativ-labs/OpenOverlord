import { Check, CheckCircle2, Copy, MoreVertical, Pencil, RotateCcw, Trash2 } from 'lucide-react';

import type { ObjectiveState } from '../../../shared/contract.ts';
import { useCopyToClipboard } from '../../lib/hooks/use-copy-to-clipboard.ts';
import { useDeleteObjective, useUpdateObjective } from '../../lib/queries.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu.tsx';

type ObjectiveMenuButtonProps = {
  objectiveId: string;
  state: ObjectiveState;
  onEditTitle?: () => void;
};

/**
 * Kebab menu of actions for a single objective. Replaces the inline state
 * badge that previously doubled as a state picker: state transitions are now
 * explicit menu items ("Mark complete" / "Mark draft") alongside delete, so the
 * objective row reads as a summary rather than an editable control.
 */
export function ObjectiveMenuButton({ objectiveId, state, onEditTitle }: ObjectiveMenuButtonProps) {
  const update = useUpdateObjective();
  const remove = useDeleteObjective();
  const { copied, copy } = useCopyToClipboard();

  const pending = update.isPending || remove.isPending;

  const canShowMarkComplete = state !== 'complete' && state !== 'future';
  const canShowMarkDraft = state !== 'draft' && state !== 'future';

  function setState(next: ObjectiveState) {
    update.mutate({ id: objectiveId, body: { state: next } });
  }

  function handleDelete() {
    if (confirm('Delete this objective?')) remove.mutate(objectiveId);
  }

  async function handleCopyId() {
    await copy(objectiveId);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Objective options"
        title="Objective options"
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={event => event.stopPropagation()}
      >
        <MoreVertical className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[160px]">
        {onEditTitle ? (
          <DropdownMenuItem className="gap-2 text-xs" onClick={onEditTitle}>
            <Pencil className="h-3.5 w-3.5" />
            Edit title
          </DropdownMenuItem>
        ) : null}
        {canShowMarkComplete ? (
          <DropdownMenuItem
            className="gap-2 text-xs"
            disabled={pending}
            onClick={() => setState('complete')}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Mark complete
          </DropdownMenuItem>
        ) : null}
        {canShowMarkDraft ? (
          <DropdownMenuItem
            className="gap-2 text-xs"
            disabled={pending}
            onClick={() => setState('draft')}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Mark draft
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem className="gap-2 text-xs" onClick={handleCopyId}>
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-600" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          Copy objective ID
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-2 text-xs"
          variant="destructive"
          disabled={pending}
          onClick={handleDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import { useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { type ButtonLoadingState, LoadingButton } from '@/components/ui/loading-button';
import { useDeleteTicket } from '@/lib/queries.ts';
import { cn } from '@/lib/utils';

type DeleteTicketButtonProps = {
  ticketId: string;
  projectId: string;
  ticketLabel?: string;
  className?: string;
};

export function DeleteTicketButton({
  ticketId,
  projectId,
  ticketLabel,
  className
}: DeleteTicketButtonProps) {
  const navigate = useNavigate();
  const remove = useDeleteTicket();
  const [open, setOpen] = useState(false);
  const [deleteButtonState, setDeleteButtonState] = useState<ButtonLoadingState>('default');

  async function handleConfirm() {
    setDeleteButtonState('loading');
    try {
      await remove.mutateAsync(ticketId);
      setDeleteButtonState('success');
      setOpen(false);
      navigate({ to: '/projects/$projectId', params: { projectId } });
    } catch {
      setDeleteButtonState('error');
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn(
          'h-7 w-7 border border-red-600/30 text-red-600 hover:bg-red-600 hover:text-white',
          className
        )}
        aria-label="Delete ticket"
        onClick={e => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Trash2 className="h-4 w-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} onClick={e => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Delete this task?</DialogTitle>
            <DialogDescription>
              This will permanently delete this task{ticketLabel ? ` (${ticketLabel})` : ''}. This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={e => {
                e.stopPropagation();
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <LoadingButton
              buttonState={deleteButtonState}
              setButtonState={setDeleteButtonState}
              text="Delete"
              loadingText="Deleting…"
              errorText="Failed to delete"
              variant="destructive"
              onClick={() => void handleConfirm()}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

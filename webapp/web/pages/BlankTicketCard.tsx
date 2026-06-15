import { useCallback, useEffect, useRef, useState } from 'react';

import { RepositoryMentionTextarea } from '@/components/RepositoryMentionTextarea.tsx';
import { Card, CardContent } from '@/components/ui/card';
import type { TextareaHandle } from '@/lib/types/text-control';

export type BlankTicketCreateOptions = Record<string, never>;

type BlankTicketCardProps = {
  inputId: string;
  statusId: string;
  position: 'top' | 'bottom';
  projectId: string;
  expand?: boolean;
  closeOnSubmit?: boolean;
  onCreateTicket: (
    statusId: string,
    objective: string,
    position: 'top' | 'bottom',
    options?: BlankTicketCreateOptions
  ) => Promise<void> | void;
  onCreateAndOpenTicket?: (
    statusId: string,
    objective: string,
    position: 'top' | 'bottom',
    options?: BlankTicketCreateOptions
  ) => Promise<void> | void;
  onClose: () => void;
  onSubmitted?: () => void;
  focusTrigger?: number;
};

export function BlankTicketCard({
  inputId,
  statusId,
  position,
  projectId,
  expand = true,
  closeOnSubmit = false,
  onCreateTicket,
  onCreateAndOpenTicket,
  onClose,
  onSubmitted,
  focusTrigger = 0
}: BlankTicketCardProps) {
  const [value, setValue] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(value);
  const handleDismissRef = useRef<(currentValue: string) => Promise<void>>(async () => {});

  valueRef.current = value;

  useEffect(() => {
    if (focusTrigger === 0) return;
    const textArea = document.getElementById(inputId) as TextareaHandle | null;
    if (!textArea) return;
    textArea.focus();
    const cursor = valueRef.current.length;
    textArea.setSelectionRange(cursor, cursor);
  }, [focusTrigger, inputId]);

  const handleBlur = useCallback(
    async (currentValue: string) => {
      if (isCreating) return;
      const trimmed = currentValue.trim();
      onClose();
      setValue('');
      if (trimmed) {
        setIsCreating(true);
        try {
          await onCreateTicket(statusId, trimmed, position);
        } finally {
          setIsCreating(false);
        }
      }
    },
    [isCreating, onClose, onCreateTicket, position, statusId]
  );

  handleDismissRef.current = handleBlur;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || cardRef.current?.contains(target)) return;

      const active = document.activeElement;
      const input = document.getElementById(inputId);
      const isThisCardFocused = active === input || Boolean(cardRef.current?.contains(active));
      if (!isThisCardFocused) return;

      void handleDismissRef.current(valueRef.current);
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [inputId]);

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        setValue('');
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (isCreating) return;
        const trimmed = e.currentTarget.value.trim();
        if (!trimmed) {
          onClose();
          setValue('');
          return;
        }
        setIsCreating(true);
        setValue('');
        try {
          if (e.metaKey && onCreateAndOpenTicket) {
            await onCreateAndOpenTicket(statusId, trimmed, position);
          } else {
            await onCreateTicket(statusId, trimmed, position);
          }
        } finally {
          setIsCreating(false);
        }
        if (closeOnSubmit) {
          onClose();
        }
        onSubmitted?.();
      }
    },
    [
      closeOnSubmit,
      isCreating,
      onClose,
      onCreateAndOpenTicket,
      onCreateTicket,
      onSubmitted,
      position,
      statusId
    ]
  );

  return (
    <Card ref={cardRef} className="overflow-hidden rounded-md border-border/60 shadow-sm py-0">
      <CardContent className="p-2 ">
        <RepositoryMentionTextarea
          id={inputId}
          autoFocus
          projectId={projectId}
          value={value}
          onValueChange={setValue}
          placeholder="What needs to be done?"
          disabled={isCreating}
          onKeyDown={handleKeyDown}
          onBlur={e => {
            void handleBlur(e.currentTarget.value);
          }}
          className={
            expand
              ? 'min-h-[156px] resize-none border-0 p-1 text-sm shadow-none focus-visible:ring-0'
              : 'min-h-[78px] resize-none border-0 p-1 text-sm shadow-none focus-visible:ring-0'
          }
          rows={expand ? 7 : 4}
        />
        {onCreateAndOpenTicket ? (
          <p className="px-1 pt-1 text-[10px] text-muted-foreground/60">⌘↵ to save &amp; open</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

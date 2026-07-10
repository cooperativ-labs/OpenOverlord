import { ChevronUp } from 'lucide-react';
import { useState } from 'react';

import type { ExecutionRequestDto, ObjectiveDto } from '../../../shared/contract.ts';
import { useDeleteObjective, useUpdateObjective } from '../../lib/queries.ts';
import { useRepositoryMentionOptions } from '../../lib/useRepositoryMentionOptions.ts';
import { cn } from '../../lib/utils.ts';
import { InlineEditField } from '../InlineEditField.tsx';
import { FileDropZone } from '../ui/file-drop-zone.tsx';

import {
  ObjectiveAttachmentList,
  ObjectiveAttachmentUploadTrigger,
  useObjectiveAttachmentState
} from './ObjectiveAttachments.tsx';
import { DraftObjectiveToolbar } from './DraftObjectiveToolbar.tsx';

type DraftObjectiveProps = {
  objective: ObjectiveDto;
  /** All objectives on the mission — used to detect an already-active sibling. */
  siblings: ObjectiveDto[];
  /** Active execution requests for the mission (from MissionDetailDto). */
  executionRequests: ExecutionRequestDto[];
};

/**
 * One objective card with the launch surface: state-aware styling, inline
 * instruction editing, auto-advance toggle, agent/model chooser, and the
 * split run button (or Promote for `future` objectives).
 */
export function DraftObjective({ objective, siblings, executionRequests }: DraftObjectiveProps) {
  const update = useUpdateObjective();
  const remove = useDeleteObjective();
  const { mentionPaths, projectMentionOptions, missionMentionOptions } =
    useRepositoryMentionOptions(objective.projectId, objective.resourceKey);
  const [isFutureExpanded, setIsFutureExpanded] = useState(false);

  const isFuture = objective.state === 'future';
  const {
    attachments,
    error: attachmentError,
    removingId,
    isUploading,
    inputRef,
    handleFiles,
    handleInputChange,
    handleRemove,
    dragState
  } = useObjectiveAttachmentState(objective.id, { dropDisabled: isFuture });
  const isLaunching = objective.state === 'launching';

  return (
    <FileDropZone
      onDrop={handleFiles}
      disabled={isUploading || isFuture}
      dragState={dragState}
      className={cn(
        'w-full overflow-hidden rounded-xl border transition-all focus-within:shadow-md focus-within:ring-1 focus-within:ring-ring/50 md:min-w-[350px]',
        isFuture
          ? 'border-border/50 bg-muted/20 opacity-70 focus-within:opacity-100'
          : 'border-muted-foreground/20',
        isLaunching && 'border-sky-400/45 bg-sky-500/5 focus-within:ring-sky-400/30'
      )}
      onFocusCapture={() => {
        if (isFuture) setIsFutureExpanded(true);
      }}
    >
      {/* Instruction body — future objectives collapse until focused */}
      <div
        className={cn(
          'relative px-3 pb-2 pt-3 transition-[max-height] duration-200 ease-in-out',
          isFuture && !isFutureExpanded && 'max-h-13 overflow-hidden',
          isFuture && isFutureExpanded && 'max-h-[500px] overflow-y-auto'
        )}
      >
        <div className={cn('text-sm leading-relaxed', isFuture && 'text-muted-foreground')}>
          <InlineEditField
            multiline
            value={objective.instructionText}
            className="text-base text-foreground/90 font-medium whitespace-pre-wrap"
            inputClassName="text-base text-foreground/90 font-medium whitespace-pre-wrap"
            minRows={objective.state === 'draft' ? 2 : undefined}
            placeholder="Describe what the agent should do… (@ file, # project, $ mission)"
            ariaLabel="Objective instruction"
            commitEmpty={objective.state === 'future' || objective.state === 'draft'}
            mentionPaths={mentionPaths}
            projectMentionOptions={projectMentionOptions}
            missionMentionOptions={missionMentionOptions}
            onSave={instructionText => {
              if (!instructionText.trim() && objective.state === 'future') {
                remove.mutate(objective.id);
                return;
              }
              update.mutate({ id: objective.id, body: { instructionText } });
            }}
          />
        </div>
        {isFuture && isFutureExpanded ? (
          <button
            type="button"
            className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-border/50 bg-background/90 text-muted-foreground shadow-sm hover:bg-background hover:text-foreground"
            aria-label="Collapse objective"
            onClick={() => {
              setIsFutureExpanded(false);
              (document.activeElement as HTMLElement | null)?.blur();
            }}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {isFuture && !isFutureExpanded ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-background/80 to-transparent" />
        ) : null}
      </div>

      {/* Attachments + toolbar. The whole card is the drop target (FileDropZone);
          the footer + button opens the file browser. */}
      <div className="border-t border-border/40">
        {!isFuture ? (
          <>
            <ObjectiveAttachmentList
              attachments={attachments}
              removingId={removingId}
              onRemove={handleRemove}
              toolbar
            />
            {attachmentError ? (
              <p className="px-3 pb-1 text-xs text-destructive">{attachmentError}</p>
            ) : null}
            <ObjectiveAttachmentUploadTrigger
              attachmentsCount={attachments.length}
              inputRef={inputRef}
              onInputChange={handleInputChange}
              disabled={isUploading}
            >
              <DraftObjectiveToolbar
                objective={objective}
                siblings={siblings}
                executionRequests={executionRequests}
              />
            </ObjectiveAttachmentUploadTrigger>
          </>
        ) : (
          <div className="@container/objective-toolbar flex min-w-0 flex-wrap items-center justify-end gap-2 px-3 py-2">
            <div className="grow" />
            <DraftObjectiveToolbar
              objective={objective}
              siblings={siblings}
              executionRequests={executionRequests}
            />
          </div>
        )}
      </div>
    </FileDropZone>
  );
}

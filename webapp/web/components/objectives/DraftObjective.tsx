import {
  ArrowUpCircle,
  Check,
  ChevronUp,
  FastForward,
  Loader2,
  MoreVertical,
  PauseCircle,
  Trash2
} from 'lucide-react';
import { useState } from 'react';

import type {
  ExecutionRequestDto,
  ObjectiveDto,
  ObjectiveState
} from '../../../shared/contract.ts';
import { useDeleteObjective, useUpdateObjective } from '../../lib/queries.ts';
import { useRepositoryMentionOptions } from '../../lib/useRepositoryMentionOptions.ts';
import { cn } from '../../lib/utils.ts';
import { InlineEditField } from '../InlineEditField.tsx';
import { Button, OBJECTIVE_STATE_LABEL } from '../ui.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu.tsx';
import { FileDropZone } from '../ui/file-drop-zone.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Switch } from '../ui/switch.tsx';

import { AgentLaunchButton } from './AgentLaunchButton.tsx';
import { AgentModelChooserButton } from './AgentModelChooserButton.tsx';
import {
  ObjectiveAttachmentList,
  ObjectiveAttachmentUploadTrigger,
  useObjectiveAttachmentState
} from './ObjectiveAttachments.tsx';
import { useObjectiveAgentSelection } from './useObjectiveAgentSelection.ts';

const AUTO_ADVANCE_TOGGLE_STATES: ObjectiveState[] = ['future', 'draft', 'submitted', 'launching'];
const ACTIVE_SIBLING_STATES: ObjectiveState[] = ['launching', 'executing', 'pending_delivery'];
const OBJECTIVE_STATES: ObjectiveState[] = [
  'future',
  'draft',
  'submitted',
  'launching',
  'executing',
  'pending_delivery',
  'complete'
];

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
  const { catalog, agentConfigs, selection, setSelection, commitLaunchConfig, loaded } =
    useObjectiveAgentSelection(objective);
  const { mentionPaths, projectMentionOptions, missionMentionOptions } = useRepositoryMentionOptions(
    objective.projectId
  );
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
  const isSubmitted = objective.state === 'submitted';
  const isLaunching = objective.state === 'launching';
  const isLaunchable = objective.state === 'draft' || isSubmitted || isLaunching;
  const canToggleAutoAdvance = AUTO_ADVANCE_TOGGLE_STATES.includes(objective.state);
  const hasActiveSibling = siblings.some(
    o => o.id !== objective.id && ACTIVE_SIBLING_STATES.includes(o.state)
  );
  const activeRequest = executionRequests.find(r => r.objectiveId === objective.id) ?? null;
  const autoAdvancePending =
    update.isPending && update.variables?.id === objective.id
      ? update.variables.body.autoAdvance !== undefined
      : false;

  function handlePromote() {
    update.mutate({ id: objective.id, body: { state: 'draft' } });
  }

  const toolbarActions = (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label="Objective actions"
          title="Objective actions"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[160px]">
          {OBJECTIVE_STATES.map(s => (
            <DropdownMenuItem
              key={s}
              className="gap-2 text-xs"
              onClick={() => update.mutate({ id: objective.id, body: { state: s } })}
            >
              <span>{OBJECTIVE_STATE_LABEL[s]}</span>
              {s === objective.state && <Check className="ml-auto h-3 w-3 text-muted-foreground" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2 text-xs text-red-600 focus:text-red-600"
            onClick={() => {
              if (confirm('Delete this objective?')) remove.mutate(objective.id);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Delete objective</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {canToggleAutoAdvance ? (
        <Popover>
          <PopoverTrigger
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors hover:bg-accent',
              objective.autoAdvance ? 'text-emerald-600' : 'text-amber-600'
            )}
            aria-label={objective.autoAdvance ? 'Auto-advance on' : 'Auto-advance off'}
            title={objective.autoAdvance ? 'Auto-advance ON' : 'Auto-advance OFF'}
          >
            {autoAdvancePending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : objective.autoAdvance ? (
              <FastForward className="h-3.5 w-3.5" />
            ) : (
              <PauseCircle className="h-3.5 w-3.5" />
            )}
          </PopoverTrigger>
          <PopoverContent className="w-64" align="end">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">Auto-advance</span>
                <Switch
                  checked={objective.autoAdvance}
                  disabled={autoAdvancePending}
                  onCheckedChange={next =>
                    update.mutate({ id: objective.id, body: { autoAdvance: next } })
                  }
                />
              </div>
              <p className="text-xs text-muted-foreground">
                When enabled, this objective will automatically start executing after the previous
                one completes. When disabled, it will wait for manual approval before starting.
              </p>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}

      <AgentModelChooserButton
        catalog={catalog}
        selection={selection}
        onChange={setSelection}
        agentConfigs={agentConfigs}
        onLaunchConfigCommit={commitLaunchConfig}
      />

      {isFuture ? (
        <Button
          variant="secondary"
          className="h-8 gap-1.5 px-3 text-xs"
          disabled={update.isPending}
          onClick={handlePromote}
        >
          {update.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ArrowUpCircle className="h-3.5 w-3.5" />
          )}
          Promote
        </Button>
      ) : isLaunchable ? (
        <AgentLaunchButton
          objective={objective}
          selection={selection}
          selectionLoaded={loaded}
          hasActiveSibling={hasActiveSibling}
          activeRequest={activeRequest}
          size="sm"
        />
      ) : null}
    </>
  );

  return (
    <FileDropZone
      onDrop={handleFiles}
      disabled={isUploading || isFuture}
      dragState={dragState}
      className={cn(
        'w-full overflow-hidden rounded-xl border transition-all focus-within:shadow-md dark:focus-within:ring-1 focus-within:ring-ring/50 md:min-w-[350px]',
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
            className="text-sm whitespace-pre-wrap"
            inputClassName="text-sm whitespace-pre-wrap"
            minRows={objective.state === 'draft' ? 4 : undefined}
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
              {toolbarActions}
            </ObjectiveAttachmentUploadTrigger>
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2 px-3 py-2">
            <div className="grow" />
            {toolbarActions}
          </div>
        )}
      </div>
    </FileDropZone>
  );
}

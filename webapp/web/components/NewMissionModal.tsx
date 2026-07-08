import { AlertTriangle, Check, ChevronDown, Loader2, Play, Tag } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { AgentModelChooserButton } from '@/components/objectives/AgentModelChooserButton.tsx';
import {
  type AgentModelSelection,
  MANUAL_AGENT_KEY
} from '@/components/objectives/AgentModelSelector.tsx';
import { ObjectiveResourcePicker } from '@/components/objectives/ObjectiveResourcePicker.tsx';
import { RepositoryMentionTextarea } from '@/components/RepositoryMentionTextarea.tsx';
import { Button } from '@/components/ui.tsx';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu.tsx';
import { api } from '@/lib/api.ts';
import { buildDueDatetime } from '@/lib/due-datetime.ts';
import { readLastUsedProjectId, writeLastUsedProjectId } from '@/lib/last-used-project.ts';
import {
  executionTargetAvailability,
  objectiveResourceConnection
} from '@/lib/project-resources.ts';
import {
  useAgentCatalog,
  useCreateMission,
  useLaunchObjective,
  useLaunchPreference,
  useLaunchSettings,
  useProjectExecutionTarget,
  useProjectResources,
  useProjects,
  useProjectTags,
  useUpdateAgentLaunchConfig,
  useUpdateLaunchPreference,
  useUpdateObjective
} from '@/lib/queries.ts';

import { Dialog, DialogContent, DialogTitle } from './ui/dialog';

type NewMissionModalProps = {
  open: boolean;
  onClose: () => void;
  defaultProjectId?: string | null;
  defaultStatusId?: string | null;
  /** When set (e.g. from a calendar day click), the new mission gets this due date on save. */
  defaultDueDate?: Date | null;
};

/**
 * Create-a-mission surface styled to match the DraftObjective launch card: an
 * instruction body over a footer toolbar. The footer carries the project and
 * tag selectors on the left, and the agent/model chooser plus Save / Run
 * actions on the right. There is no priority selector — new missions always
 * land in the workspace default status.
 */
export function NewMissionModal({
  open,
  onClose,
  defaultProjectId = null,
  defaultStatusId = null,
  defaultDueDate = null
}: NewMissionModalProps) {
  const projectsQ = useProjects();
  const projects = useMemo(() => projectsQ.data ?? [], [projectsQ.data]);
  const createMission = useCreateMission();
  const launchObjective = useLaunchObjective();
  const updateObjective = useUpdateObjective();
  const catalogQ = useAgentCatalog();
  const settingsQ = useLaunchSettings();
  const updateAgentConfig = useUpdateAgentLaunchConfig();

  const [instruction, setInstruction] = useState('');
  const [resourceKey, setResourceKey] = useState<string | null>(null);
  const [projectId, setProjectId] = useState('');
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [pendingAction, setPendingAction] = useState<'save' | 'run' | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fallbackProjectId = useMemo(() => {
    const lastUsed = readLastUsedProjectId();
    return lastUsed && projects.some(project => project.id === lastUsed) ? lastUsed : null;
  }, [projects]);

  const selectedProjectId =
    projectId ||
    (defaultProjectId && projects.some(project => project.id === defaultProjectId)
      ? defaultProjectId
      : (fallbackProjectId ?? projects[0]?.id ?? ''));

  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null;

  const tagsQ = useProjectTags(selectedProjectId || null);
  const tags = useMemo(() => (tagsQ.data ?? []).filter(tag => tag.active), [tagsQ.data]);

  const preferenceQ = useLaunchPreference(selectedProjectId);
  const resourcesQ = useProjectResources(selectedProjectId);
  const executionTargetQ = useProjectExecutionTarget(selectedProjectId);
  const updatePreference = useUpdateLaunchPreference(selectedProjectId);

  const catalog = catalogQ.data ?? null;
  const agentConfigs = settingsQ.data?.agentConfigs ?? {};
  const selectionLoaded = Boolean(catalog) && !preferenceQ.isLoading && !settingsQ.isLoading;
  const primaryConnection = objectiveResourceConnection({
    resources: resourcesQ.data ?? [],
    resourceKey,
    executionTargetId: executionTargetQ.data?.selectedExecutionTargetId ?? null
  });
  const targetAvailability = executionTargetAvailability({
    primaryConnected: primaryConnection.connected,
    eligibleTargets: executionTargetQ.data?.eligibleTargets
  });

  const defaultSelection = useMemo<AgentModelSelection>(() => {
    if (preferenceQ.data?.selectedAgent) {
      return {
        agent: preferenceQ.data.selectedAgent,
        model: preferenceQ.data.selectedModel,
        reasoningEffort: preferenceQ.data.selectedReasoningEffort
      };
    }
    return {
      agent: catalog?.defaultAgent ?? 'claude',
      model: catalog?.defaultModel ?? null,
      reasoningEffort: null
    };
  }, [catalog, preferenceQ.data]);

  const [selection, setSelection] = useState<AgentModelSelection>(defaultSelection);

  useEffect(() => {
    setSelection(defaultSelection);
  }, [defaultSelection]);

  // Reset transient state each time the modal opens; keep the project sticky.
  useEffect(() => {
    if (!open) return;
    setInstruction('');
    setResourceKey(null);
    setSelectedTagIds([]);
    setSubmitError(null);
    setProjectId(current => {
      if (defaultProjectId && projects.some(project => project.id === defaultProjectId)) {
        return defaultProjectId;
      }
      if (current && projects.some(project => project.id === current)) {
        return current;
      }
      return fallbackProjectId ?? projects[0]?.id ?? '';
    });
  }, [defaultProjectId, fallbackProjectId, open, projects]);

  // Tags are project-scoped — drop any that no longer belong to the project.
  useEffect(() => {
    setSelectedTagIds(current => current.filter(id => tags.some(tag => tag.id === id)));
  }, [tags]);

  const handleSelectionChange = (next: AgentModelSelection) => {
    setSelection(next);
    if (!selectedProjectId) return;
    updatePreference.mutate({
      selectedAgent: next.agent,
      selectedModel: next.model,
      selectedReasoningEffort: next.reasoningEffort
    });
  };

  const isBusy = pendingAction !== null;
  const isManual = selection.agent === MANUAL_AGENT_KEY;
  const canSubmit =
    Boolean(instruction.trim()) && Boolean(selectedProjectId) && selectionLoaded && !isBusy;
  const canRun =
    canSubmit && !isManual && primaryConnection.connected && targetAvailability.available;

  async function submit(shouldLaunch: boolean) {
    const text = instruction.trim();
    if (!text || !selectedProjectId || !selectionLoaded || isBusy) return;

    setPendingAction(shouldLaunch ? 'run' : 'save');
    setSubmitError(null);

    try {
      if (shouldLaunch && isManual) {
        throw new Error('Please select an agent to launch this task');
      }
      if (shouldLaunch && !primaryConnection.connected) {
        throw new Error(primaryConnection.message ?? 'Primary resource is not connected.');
      }
      if (shouldLaunch && !targetAvailability.available) {
        throw new Error(targetAvailability.message ?? 'No execution target is available.');
      }

      // Omit statusId so the mission lands in the workspace default status,
      // unless the caller asked for a specific column (e.g. a workspace board
      // column's "Add mission" button).
      const detail = await createMission.mutateAsync({
        projectId: selectedProjectId,
        objectives: [{ objective: text, ...(resourceKey ? { resourceKey } : {}) }],
        statusId: defaultStatusId ?? undefined,
        tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined
      });
      if (defaultDueDate) {
        await api.updateMission(detail.id, {
          dueDatetime: buildDueDatetime({
            selectedDate: defaultDueDate,
            currentDueDatetime: null
          })
        });
      }
      writeLastUsedProjectId(selectedProjectId);
      const createdObjective = detail.objectives[0];
      if (!createdObjective) {
        throw new Error('Mission was created without an objective.');
      }

      if (shouldLaunch) {
        await launchObjective.mutateAsync({
          id: createdObjective.id,
          body: {
            agent: selection.agent,
            model: selection.model,
            reasoningEffort: selection.reasoningEffort
          }
        });
      } else {
        await updateObjective.mutateAsync({
          id: createdObjective.id,
          body: {
            assignedAgent: selection.agent,
            model: selection.model,
            reasoningEffort: selection.reasoningEffort
          }
        });
        if (selectedProjectId) {
          updatePreference.mutate({
            selectedAgent: selection.agent,
            selectedModel: selection.model,
            selectedReasoningEffort: selection.reasoningEffort
          });
        }
      }

      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to create mission.');
    } finally {
      setPendingAction(null);
    }
  }

  const selectedTags = tags.filter(tag => selectedTagIds.includes(tag.id));

  // Dismissing the modal (Escape, outside click, or the close button) all
  // route through onOpenChange(false). Treat that the same as clicking Save
  // so an in-progress draft is persisted instead of discarded.
  async function handleDialogClose() {
    if (isBusy) return;
    const text = instruction.trim();
    if (!text || !selectedProjectId || !selectionLoaded) {
      onClose();
      return;
    }
    await submit(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) void handleDialogClose();
      }}
    >
      <DialogContent
        className="gap-0 p-0 sm:max-w-xl shadow-none ring-0 bg-transparent"
        showCloseButton
      >
        <DialogTitle className="sr-only">New mission</DialogTitle>

        <div className="w-full overflow-hidden rounded-xl border border-muted-foreground/20 transition-all focus-within:shadow-md dark:focus-within:ring-1 focus-within:ring-ring/50 bg-background">
          {/* Instruction body */}

          <RepositoryMentionTextarea
            autoFocus
            rows={4}
            projectId={selectedProjectId}
            value={instruction}
            placeholder="Describe what the agent should do… (@ file, # project, $ mission)"
            onValueChange={setInstruction}
            className="w-full min-h-32 max-h-[200px] md:max-h-[600px] border-none bg-transparent text-sm leading-relaxed shadow-none placeholder:text-muted-foreground/70 p-4"
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(false);
            }}
          />

          {/* Footer toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 px-3 py-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Project selector */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={projects.length === 0 || isBusy}
                  aria-label="Choose project"
                  title="Choose project"
                >
                  <span
                    className="h-3 w-3 shrink-0 rounded-[4px] border"
                    style={{
                      backgroundColor: selectedProject?.color ?? undefined,
                      borderColor: selectedProject?.color ?? undefined
                    }}
                  />
                  <span className="max-w-[140px] truncate">
                    {selectedProject?.name ?? 'No project'}
                  </span>
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[180px]">
                  <DropdownMenuLabel>Project</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {projects.map(project => (
                    <DropdownMenuItem
                      key={project.id}
                      className="gap-2 text-xs"
                      onClick={() => {
                        setProjectId(project.id);
                        setSelectedTagIds([]);
                      }}
                    >
                      <span
                        className="h-3 w-3 shrink-0 rounded-[4px] border"
                        style={{
                          backgroundColor: project.color ?? undefined,
                          borderColor: project.color ?? undefined
                        }}
                      />
                      <span className="truncate">{project.name}</span>
                      {project.id === selectedProjectId && (
                        <Check className="ml-auto h-3 w-3 text-muted-foreground" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Tag selector */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!selectedProjectId || tags.length === 0 || isBusy}
                  aria-label="Add tags"
                  title={tags.length === 0 ? 'No tags for this project' : 'Add tags'}
                >
                  <Tag className="h-3.5 w-3.5 shrink-0" />
                  {selectedTags.length > 0 ? (
                    <span className="flex items-center gap-1">
                      {selectedTags.slice(0, 2).map(tag => (
                        <span key={tag.id} className="flex items-center gap-1">
                          {tag.color ? (
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full border"
                              style={{ backgroundColor: tag.color, borderColor: tag.color }}
                            />
                          ) : null}
                          <span className="max-w-[80px] truncate">{tag.label}</span>
                        </span>
                      ))}
                      {selectedTags.length > 2 ? <span>+{selectedTags.length - 2}</span> : null}
                    </span>
                  ) : (
                    <span>Tags</span>
                  )}
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[200px]">
                  <DropdownMenuLabel>Tags</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {tags.map(tag => (
                    <DropdownMenuCheckboxItem
                      key={tag.id}
                      checked={selectedTagIds.includes(tag.id)}
                      onCheckedChange={() =>
                        setSelectedTagIds(current =>
                          current.includes(tag.id)
                            ? current.filter(id => id !== tag.id)
                            : [...current, tag.id]
                        )
                      }
                      onSelect={event => event.preventDefault()}
                      className="gap-2"
                    >
                      {tag.color ? (
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full border"
                          style={{ backgroundColor: tag.color, borderColor: tag.color }}
                        />
                      ) : null}
                      <span className="truncate">{tag.label}</span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <ObjectiveResourcePicker
                resources={resourcesQ.data ?? []}
                value={resourceKey}
                disabled={isBusy}
                onChange={setResourceKey}
              />
            </div>

            <div className="flex items-center gap-1.5">
              <AgentModelChooserButton
                catalog={catalog}
                selection={selection}
                onChange={handleSelectionChange}
                agentConfigs={agentConfigs}
                onLaunchConfigCommit={(agentKey, config) =>
                  updateAgentConfig.mutate({ agentKey, body: config })
                }
                disabled={isBusy}
              />

              <Button
                variant="secondary"
                className="h-8 px-3 text-xs"
                onClick={() => void submit(false)}
                disabled={!canSubmit}
              >
                {pendingAction === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Save
              </Button>

              {isManual ? null : (
                <Button
                  variant="primary"
                  className="h-8 gap-1.5 px-3 text-xs"
                  onClick={() => void submit(true)}
                  disabled={!canRun}
                >
                  {pendingAction === 'run' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  Run
                </Button>
              )}
            </div>
          </div>
        </div>

        {submitError ? <p className="text-xs text-red-400">{submitError}</p> : null}
        {!primaryConnection.connected && selectionLoaded && selectedProjectId ? (
          <div className="bg-background rounded-md mt-1">
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-200"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <p>{primaryConnection.message}</p>
            </div>
          </div>
        ) : !targetAvailability.available && selectionLoaded && selectedProjectId ? (
          <div className="bg-background rounded-md mt-1">
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-200"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <p>{targetAvailability.message}</p>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

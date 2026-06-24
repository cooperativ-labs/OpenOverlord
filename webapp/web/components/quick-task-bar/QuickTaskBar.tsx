import { AlertTriangle, ArrowUp, Loader2, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AgentModelChooserButton } from '@/components/objectives/AgentModelChooserButton.tsx';
import type { AgentModelSelection } from '@/components/objectives/AgentModelSelector.tsx';
import { RepositoryMentionTextarea } from '@/components/RepositoryMentionTextarea.tsx';
import { api } from '@/lib/api.ts';
import { primaryResourceConnection } from '@/lib/project-resources.ts';
import {
  useAgentCatalog,
  useCreateMission,
  useLaunchObjective,
  useLaunchPreference,
  useLaunchSettings,
  useProjectResources,
  useProjects,
  useUpdateAgentLaunchConfig,
  useUpdateLaunchPreference,
  useUpdateObjective
} from '@/lib/queries.ts';
import { cn } from '@/lib/utils';

import { ProjectPickerPanel } from './ProjectPickerPanel.tsx';
import {
  getQuickTaskApi,
  type ProjectOption,
  resolveProjectId,
  type StagedFile
} from './quick-task-helpers.ts';
import {
  readStoredDefaultProjectId,
  writeStoredDefaultProjectId
} from './quick-task-page-state.ts';
import { StagedFilesRow } from './StagedFilesRow.tsx';

type QuickTaskBarProps = {
  defaultProjectId?: string | null;
};

export function QuickTaskBar({ defaultProjectId = null }: QuickTaskBarProps) {
  const projectsQ = useProjects();
  const createMission = useCreateMission();
  const launchObjective = useLaunchObjective();
  const updateObjective = useUpdateObjective();
  const catalogQ = useAgentCatalog();
  const settingsQ = useLaunchSettings();

  const projects = useMemo<ProjectOption[]>(
    () =>
      (projectsQ.data ?? []).map(project => ({
        id: project.id,
        name: project.name,
        color: project.color
      })),
    [projectsQ.data]
  );

  const resolvedDefaultProjectId = resolveProjectId(projects, defaultProjectId);

  const [objective, setObjective] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState(() =>
    resolveProjectId(projects, defaultProjectId ?? readStoredDefaultProjectId())
  );
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeMenu, setActiveMenu] = useState<'project' | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlBarRef = useRef<HTMLDivElement>(null);

  const resolveTextarea = useCallback(() => {
    return containerRef.current?.querySelector('textarea') ?? null;
  }, []);

  const preferenceQ = useLaunchPreference(selectedProjectId);
  const resourcesQ = useProjectResources(selectedProjectId);
  const updatePreference = useUpdateLaunchPreference(selectedProjectId);
  const updateAgentConfig = useUpdateAgentLaunchConfig();

  const catalog = catalogQ.data ?? null;
  const agentConfigs = settingsQ.data?.agentConfigs ?? {};
  const selectionLoaded = Boolean(catalog) && !preferenceQ.isLoading && !settingsQ.isLoading;

  const defaultSelection = useMemo<AgentModelSelection>(() => {
    if (preferenceQ.data?.selectedAgent) {
      return {
        agent: preferenceQ.data.selectedAgent,
        model: preferenceQ.data.selectedModel,
        reasoningEffort: preferenceQ.data.selectedReasoningEffort
      };
    }
    return {
      agent: catalog?.defaultAgent ?? 'cursor',
      model: catalog?.defaultModel ?? null,
      reasoningEffort: null
    };
  }, [catalog, preferenceQ.data]);

  const [objectiveSelection, setObjectiveSelection] =
    useState<AgentModelSelection>(defaultSelection);

  useEffect(() => {
    setObjectiveSelection(defaultSelection);
  }, [defaultSelection]);

  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null;
  const primaryConnection = primaryResourceConnection(resourcesQ.data ?? []);

  useEffect(() => {
    setSelectedProjectId(current => {
      if (current && projects.some(project => project.id === current)) {
        return current;
      }
      return resolvedDefaultProjectId;
    });
  }, [projects, resolvedDefaultProjectId]);

  const autoResize = useCallback(() => {
    const el = resolveTextarea();
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;

    const container = containerRef.current;
    const bar = controlBarRef.current;
    const quickTaskApi = getQuickTaskApi();
    if (!container || !quickTaskApi) return;

    if (bar && typeof quickTaskApi.setBounds === 'function') {
      const containerTop = container.getBoundingClientRect().top;
      const barTop = bar.getBoundingClientRect().top;
      quickTaskApi
        .setBounds({
          height: container.offsetHeight,
          barOffsetTop: Math.round(barTop - containerTop)
        })
        .catch(() => { });
    } else {
      quickTaskApi.setHeight(container.offsetHeight).catch(() => { });
    }
  }, [resolveTextarea]);

  useEffect(() => {
    autoResize();
  }, [autoResize, objective, stagedFiles.length, activeMenu, objectiveSelection]);

  useEffect(() => {
    if (activeMenu) return;
    requestAnimationFrame(() => {
      resolveTextarea()?.focus();
      autoResize();
    });
  }, [activeMenu, autoResize, resolveTextarea]);

  useEffect(() => {
    const quickTaskApi = getQuickTaskApi();
    if (!quickTaskApi) return;
    const off = quickTaskApi.onShown(() => {
      requestAnimationFrame(() => {
        setSelectedProjectId(resolvedDefaultProjectId);
        setObjectiveSelection(defaultSelection);
        setActiveMenu(null);
        setSubmitError(null);
        resolveTextarea()?.focus();
        autoResize();
      });
    });
    return () => {
      off?.();
    };
  }, [autoResize, defaultSelection, resolveTextarea, resolvedDefaultProjectId]);

  const handleClose = useCallback(() => {
    const quickTaskApi = getQuickTaskApi();
    if (quickTaskApi) {
      quickTaskApi.close().catch(() => { });
      return;
    }
    setObjective('');
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (activeMenu) {
          setActiveMenu(null);
          return;
        }
        handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeMenu, handleClose]);

  const handleFilesSelected = useCallback((fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const next = Array.from(fileList).map(file => ({
      id: `${Date.now()}-${file.name}-${Math.random().toString(36).slice(2, 8)}`,
      file
    }));
    setStagedFiles(prev => [...prev, ...next]);
  }, []);

  const handleRemoveFile = useCallback((id: string) => {
    setStagedFiles(prev => prev.filter(file => file.id !== id));
  }, []);

  const handleMentionMenuOpenChange = useCallback(() => {
    requestAnimationFrame(() => autoResize());
  }, [autoResize]);

  const handleSelectionChange = useCallback(
    (next: AgentModelSelection) => {
      setObjectiveSelection(next);
      if (!selectedProjectId) return;
      updatePreference.mutate({
        selectedAgent: next.agent,
        selectedModel: next.model,
        selectedReasoningEffort: next.reasoningEffort
      });
    },
    [selectedProjectId, updatePreference]
  );

  async function uploadStagedFiles(objectiveId: string, files: StagedFile[]): Promise<void> {
    if (files.length === 0) return;
    await Promise.all(
      files.map(async ({ file }) => {
        await api.uploadObjectiveAttachment(objectiveId, file);
      })
    );
  }

  async function handleSubmit(shouldLaunch = false) {
    const trimmed = objective.trim();
    if (!trimmed || !selectedProject || isSubmitting || !selectionLoaded) return;

    setIsSubmitting(true);
    setSubmitError(null);
    const filesToUpload = stagedFiles;

    try {
      if (shouldLaunch && !primaryConnection.connected) {
        throw new Error(primaryConnection.message ?? 'Primary resource is not connected.');
      }

      const detail = await createMission.mutateAsync({
        projectId: selectedProject.id,
        firstObjective: trimmed
      });
      const createdObjective = detail.objectives[0];
      if (!createdObjective) {
        throw new Error('Mission was created without an objective.');
      }

      writeStoredDefaultProjectId(selectedProject.id);

      if (shouldLaunch) {
        await launchObjective.mutateAsync({
          id: createdObjective.id,
          body: {
            agent: objectiveSelection.agent,
            model: objectiveSelection.model,
            reasoningEffort: objectiveSelection.reasoningEffort
          }
        });
      } else {
        await updateObjective.mutateAsync({
          id: createdObjective.id,
          body: {
            assignedAgent: objectiveSelection.agent,
            model: objectiveSelection.model,
            reasoningEffort: objectiveSelection.reasoningEffort
          }
        });
        updatePreference.mutate({
          selectedAgent: objectiveSelection.agent,
          selectedModel: objectiveSelection.model,
          selectedReasoningEffort: objectiveSelection.reasoningEffort
        });
      }

      if (filesToUpload.length > 0) {
        void uploadStagedFiles(createdObjective.id, filesToUpload).catch(error => {
          console.error('Failed to upload quick-task attachments:', error);
        });
      }

      setObjective('');
      setStagedFiles([]);
      handleClose();
    } catch (error) {
      console.error('Failed to create quick task:', error);
      setSubmitError(error instanceof Error ? error.message : 'Failed to create mission.');
    } finally {
      setObjectiveSelection(defaultSelection);
      setIsSubmitting(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSubmit(event.metaKey || event.ctrlKey);
    }
  }

  const canSubmit =
    Boolean(objective.trim()) && !isSubmitting && Boolean(selectedProject) && selectionLoaded;

  if (projectsQ.isLoading) {
    return (
      <div className="flex items-center justify-center p-6 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading projects…
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="electron-drag-region flex w-full flex-col gap-2 bg-neutral-50 dark:bg-neutral-900"
    >
      <div
        className={cn(
          'flex w-full flex-col gap-2 rounded-2xl border border-border/40',
          'bg-background/95 px-4 py-3 shadow-2xl backdrop-blur-md'
        )}
      >
        {selectedProject ? (
          <RepositoryMentionTextarea
            autoListContinuation="shift-enter"
            projectId={selectedProject.id}
            value={objective}
            onValueChange={nextValue => {
              setObjective(nextValue);
              autoResize();
            }}
            onMentionSelect={() => {
              requestAnimationFrame(() => autoResize());
            }}
            mentionMenuMode="inline"
            onMentionMenuOpenChange={handleMentionMenuOpenChange}
            onKeyDown={handleKeyDown}
            placeholder="Write an objective"
            rows={1}
            containerClassName="electron-no-drag"
            menuClassName="electron-no-drag"
            className={cn(
              'w-full resize-none border-none bg-transparent text-base leading-relaxed shadow-none',
              'focus:outline-none focus:ring-0',
              'placeholder:text-muted-foreground/70'
            )}
            disabled={isSubmitting}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Create a project before using quick task.</p>
        )}

        <StagedFilesRow stagedFiles={stagedFiles} onRemoveFile={handleRemoveFile} />

        <div
          ref={controlBarRef}
          className="flex items-center justify-between gap-2"
        >
          <div className="flex items-center gap-1 ">
            <button
              type="button"
              aria-label="Attach files"
              onClick={() => fileInputRef.current?.click()}
              className="electron-no-drag flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              disabled={!selectedProject || isSubmitting}
            >
              <Plus className="h-4 w-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden electron-no-drag"
              multiple
              onChange={event => {
                handleFilesSelected(event.target.files);
                event.target.value = '';
              }}
            />

            <button
              type="button"
              aria-label="Choose project"
              aria-expanded={activeMenu === 'project'}
              onClick={() => setActiveMenu(current => (current === 'project' ? null : 'project'))}
              className={cn(
                'electron-no-drag',
                'flex h-8 items-center gap-1.5 rounded-full px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                activeMenu === 'project' && 'bg-muted text-foreground'
              )}
            >
              {selectedProject ? (
                <span
                  className="h-3 w-3 rounded-[4px] border"
                  style={{
                    backgroundColor: selectedProject.color ?? undefined,
                    borderColor: selectedProject.color ?? undefined
                  }}
                />
              ) : (
                <span className="h-3 w-3 rounded-[4px] border border-border bg-muted" />
              )}
              <span className="max-w-[110px] truncate text-foreground/80">
                {selectedProject?.name ?? 'No project'}
              </span>
            </button>

            <div className="electron-no-drag">
              <AgentModelChooserButton
                catalog={catalog}
                selection={objectiveSelection}
                onChange={handleSelectionChange}
                agentConfigs={agentConfigs}
                onLaunchConfigCommit={(agentKey, config) => {
                  updateAgentConfig.mutate({ agentKey, body: config });
                }}
                disabled={isSubmitting}
                compact
              />
            </div></div>

          <button
            type="button"
            aria-label={isSubmitting ? 'Submitting' : 'Send'}
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className={cn(
              'electron-no-drag flex h-8 w-8 items-center justify-center rounded-full transition-colors',
              canSubmit
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-muted text-muted-foreground/60'
            )}
          >
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>

        {submitError ? <p className="text-xs text-red-400">{submitError}</p> : null}
        {!primaryConnection.connected && selectionLoaded ? (
          <div
            role="alert"
            className="electron-no-drag flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-200"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <p>{primaryConnection.message}</p>
          </div>
        ) : null}
      </div>

      {activeMenu === 'project' ? (
        <ProjectPickerPanel
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelect={projectId => {
            setSelectedProjectId(projectId);
            setActiveMenu(null);
          }}
        />
      ) : null}
    </div>
  );
}

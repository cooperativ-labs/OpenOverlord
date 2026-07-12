import { ChevronDown, Settings } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { ProjectTimerPopover } from '@/components/everhour/ProjectTimerPopover';
import {
  DEFAULT_PROJECT_COLOR,
  ProjectColorSetter
} from '@/components/projects/ProjectColorSetter';
import { useProjectRepositoryContext } from '@/components/projects/ProjectRepositoryContext.tsx';
import { useProjectSettings } from '@/components/projects/ProjectSettingsContext';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  buildEditorFileHref,
  getEditorSchemeIcon,
  getEditorSchemeLabel
} from '@/lib/helpers/editor-scheme';
import { useProfile, useUpdateProject } from '@/lib/queries';
import { cn } from '@/lib/utils';

type ProjectSettingsSectionProps = {
  projectId: string;
  initialName: string;
  initialColor: string | null;
};

const ANY_TARGET_VALUE = '__any_eligible_target__';

export function ProjectSettingsSection({
  projectId,
  initialName,
  initialColor
}: ProjectSettingsSectionProps) {
  const updateProject = useUpdateProject(projectId);
  const projectSettings = useProjectSettings();
  const {
    repository,
    resources,
    eligibleTargets,
    isLoading: isRepositoryLoading,
    selectedExecutionTargetId,
    setSelectedExecutionTargetId
  } = useProjectRepositoryContext();
  const profileQ = useProfile();
  const [name, setName] = useState(initialName);
  const [savedName, setSavedName] = useState(initialName);
  const [savedColor, setSavedColor] = useState(initialColor ?? DEFAULT_PROJECT_COLOR);
  const [nameEditing, setNameEditing] = useState(false);
  const [nameSaveState, setNameSaveState] = useState<ButtonLoadingState>('default');
  const [colorSaveState, setColorSaveState] = useState<ButtonLoadingState>('default');
  const [nameError, setNameError] = useState<string | null>(null);
  const [colorError, setColorError] = useState<string | null>(null);
  const [colorMenuOpen, setColorMenuOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(initialName);
    setSavedName(initialName);
  }, [initialName]);

  useEffect(() => {
    setSavedColor(initialColor ?? DEFAULT_PROJECT_COLOR);
  }, [initialColor]);

  useEffect(() => {
    if (nameEditing) nameInputRef.current?.focus();
  }, [nameEditing]);

  async function handleSaveName() {
    const trimmed = name.trim();
    if (trimmed === savedName) {
      setNameEditing(false);
      return;
    }

    setNameSaveState('loading');
    setNameError(null);

    try {
      await updateProject.mutateAsync({ name: trimmed });
      setSavedName(trimmed);
      setNameSaveState('success');
      setNameEditing(false);
    } catch (error) {
      setNameSaveState('error');
      setNameError(error instanceof Error ? error.message : 'Failed to update name.');
    }
  }

  function cancelNameEdit() {
    setName(savedName);
    setNameError(null);
    setNameEditing(false);
  }

  async function handleSelectColor(color: string) {
    if (color.toLowerCase() === savedColor.toLowerCase()) {
      setColorMenuOpen(false);
      return;
    }

    setColorSaveState('loading');
    setColorError(null);

    try {
      await updateProject.mutateAsync({ color: color.toLowerCase() });
      setSavedColor(color.toLowerCase());
      setColorSaveState('success');
      setColorMenuOpen(false);
    } catch (error) {
      setColorSaveState('error');
      setColorError(error instanceof Error ? error.message : 'Failed to update color.');
    }
  }

  const rootPath = repository?.rootPath ?? null;
  const editorScheme = profileQ.data?.editorScheme ?? null;
  const ideHref = rootPath ? buildEditorFileHref(rootPath, editorScheme) : null;
  const ideLabel = getEditorSchemeLabel(editorScheme);
  const ideIcon = getEditorSchemeIcon(editorScheme);
  const openInIdeLabel = `Open in ${ideLabel}`;

  const ideResources = resources
    .filter(resource => resource.path)
    .map(resource => ({
      id: resource.id,
      label: resource.label?.trim() || resource.resourceKey,
      href: buildEditorFileHref(resource.path, editorScheme)
    }));
  const hasMultipleIdeResources = ideResources.length > 1;
  const executionTargetSelectorValue = selectedExecutionTargetId ?? ANY_TARGET_VALUE;

  function openInIde(href: string) {
    window.open(href, '_blank', 'noopener,noreferrer');
  }

  return (
    <section className="border-b border-(--color-border) px-5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu open={colorMenuOpen} onOpenChange={setColorMenuOpen}>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="h-5 w-5 shrink-0 rounded border transition hover:ring-2 hover:ring-primary hover:ring-offset-2 disabled:opacity-50"
                style={{ backgroundColor: savedColor, borderColor: savedColor }}
                aria-label="Change project color"
                disabled={colorSaveState === 'loading'}
              />
            }
          />
          <DropdownMenuContent className="w-auto p-2" align="start">
            <ProjectColorSetter value={savedColor} onSelect={handleSelectColor} />
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="min-w-0 flex-1 items-center gap-3 md:flex">
          <div className="flex items-center gap-2">
            {nameEditing ? (
              <Input
                ref={nameInputRef}
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Mobile App"
                className="h-7 max-w-xs font-semibold"
                onBlur={handleSaveName}
                onKeyDown={e => {
                  if (e.key === 'Enter') void handleSaveName();
                  if (e.key === 'Escape') cancelNameEdit();
                }}
                disabled={nameSaveState === 'loading'}
              />
            ) : (
              <button
                type="button"
                className={cn(
                  '-ml-1.5 rounded px-1.5 py-0.5 text-left text-base font-semibold',
                  'hover:bg-muted/60'
                )}
                onClick={() => setNameEditing(true)}
              >
                {savedName || 'Untitled project'}
              </button>
            )}
            {projectSettings ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={() => projectSettings.openProjectSettings()}
                aria-label="Project settings"
              >
                <Settings className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            {eligibleTargets.length > 0 ? (
              <div className="flex shrink-0 items-center gap-1.5">
                <Label htmlFor="project-header-execution-target" className="sr-only">
                  Execution target
                </Label>
                <Select
                  value={executionTargetSelectorValue}
                  disabled={isRepositoryLoading}
                  onValueChange={value =>
                    setSelectedExecutionTargetId(value === ANY_TARGET_VALUE ? null : value)
                  }
                >
                  <SelectTrigger id="project-header-execution-target" className="h-7 max-w-48">
                    <SelectValue placeholder="Execution target" />
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleTargets.length > 1 ? (
                      <SelectItem value={ANY_TARGET_VALUE}>Any eligible target</SelectItem>
                    ) : null}
                    {eligibleTargets.map(target => (
                      <SelectItem
                        key={target.executionTargetId}
                        value={target.executionTargetId}
                        disabled={!target.reachable || !target.primaryResourceConnected}
                      >
                        {target.label}
                        {target.deviceLabel ? ` · ${target.deviceLabel}` : ''}
                        {!target.reachable ? ' (offline)' : ''}
                        {target.reachable && !target.primaryResourceConnected
                          ? ' (no primary resource)'
                          : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {ideHref ? (
              <div className="flex shrink-0 items-center">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        size={ideIcon ? 'icon-sm' : 'sm'}
                        className={cn(
                          'shrink-0',
                          !ideIcon && 'gap-1.5',
                          hasMultipleIdeResources && 'rounded-r-none border-r-0'
                        )}
                        onClick={() => openInIde(ideHref)}
                        aria-label={openInIdeLabel}
                      >
                        {ideIcon ? (
                          <img
                            src={ideIcon.src}
                            alt=""
                            width={14}
                            height={14}
                            className={cn('shrink-0', ideIcon.invertDark ? 'dark:invert' : '')}
                          />
                        ) : (
                          <>Open in {ideLabel}</>
                        )}
                      </Button>
                    }
                  />
                  <TooltipContent>{openInIdeLabel}</TooltipContent>
                </Tooltip>
                {hasMultipleIdeResources ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          className="w-6 shrink-0 rounded-l-none px-0"
                          aria-label={`Open a resource in ${ideLabel}`}
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="start">
                      {ideResources.map(resource => (
                        <DropdownMenuItem
                          key={resource.id}
                          onClick={() => openInIde(resource.href)}
                        >
                          {resource.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            ) : null}
            <div className="ml-3">
              <ProjectTimerPopover projectId={projectId} />
            </div>
          </div>
        </div>
      </div>

      {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
      {colorError ? <p className="text-xs text-destructive">{colorError}</p> : null}
    </section>
  );
}

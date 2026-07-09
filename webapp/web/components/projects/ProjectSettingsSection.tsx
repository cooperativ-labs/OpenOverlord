import { Settings } from 'lucide-react';
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
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
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

export function ProjectSettingsSection({
  projectId,
  initialName,
  initialColor
}: ProjectSettingsSectionProps) {
  const updateProject = useUpdateProject(projectId);
  const projectSettings = useProjectSettings();
  const { repository } = useProjectRepositoryContext();
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
            {ideHref ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      size={ideIcon ? 'icon-sm' : 'sm'}
                      className={cn('shrink-0', !ideIcon && 'gap-1.5')}
                      onClick={() => window.open(ideHref, '_blank', 'noopener,noreferrer')}
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
            ) : null}
            <ProjectTimerPopover projectId={projectId} />
          </div>
        </div>
      </div>

      {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
      {colorError ? <p className="text-xs text-destructive">{colorError}</p> : null}
    </section>
  );
}

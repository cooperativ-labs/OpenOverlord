import { ChevronDown } from 'lucide-react';

import { useProjectRepositoryContext } from '@/components/projects/ProjectRepositoryContext.tsx';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  buildEditorFileHref,
  getEditorSchemeIcon,
  getEditorSchemeLabel
} from '@/lib/helpers/editor-scheme';
import { useProfile } from '@/lib/queries';
import { cn } from '@/lib/utils';

function openInIde(href: string) {
  window.open(href, '_blank', 'noopener,noreferrer');
}

export function ProjectOpenInIdeButton() {
  const { repository, resources } = useProjectRepositoryContext();
  const profileQ = useProfile();

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

  if (!ideHref) {
    return null;
  }

  return (
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
              <DropdownMenuItem key={resource.id} onClick={() => openInIde(resource.href)}>
                {resource.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

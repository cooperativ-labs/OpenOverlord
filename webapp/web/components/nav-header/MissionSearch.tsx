import { useNavigate, useRouter } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { useProjects } from '@/lib/queries';
import { cn } from '@/lib/utils';

import type { MissionDto } from '../../../shared/contract.ts';

type MissionSearchProps = {
  className?: string;
};

/**
 * Global mission search bar. Debounces input, queries the shared search index via
 * GET /api/missions/search (the same endpoint and ranking the CLI uses), and
 * navigates to the selected mission. ⌘F / Ctrl+F focuses it; ⌥← / Alt+← goes back.
 */
export function MissionSearch({ className }: MissionSearchProps) {
  const navigate = useNavigate();
  const router = useRouter();
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MissionDto[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [searchShortcutHint, setSearchShortcutHint] = useState('⌘F');
  const [backShortcutHint, setBackShortcutHint] = useState('⌥←');

  // Resolve project names for the result subtitle without an extra request per
  // result; the projects list is already cached by react-query.
  const projects = useProjects();
  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects.data ?? []) map.set(project.id, project.name);
    return map;
  }, [projects.data]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setIsOpen(false);
      setActiveIndex(0);
      setIsLoading(false);
      return;
    }

    let isCurrent = true;
    setIsLoading(true);

    const timeoutId = window.setTimeout(async () => {
      try {
        const data = await api.searchMissions(query.trim());
        if (!isCurrent) return;
        const missions = Array.isArray(data?.missions) ? (data.missions as MissionDto[]) : [];
        setResults(missions);
        setIsOpen(missions.length > 0);
        setActiveIndex(0);
      } catch (error) {
        if (isCurrent) console.error(error);
      } finally {
        if (isCurrent) setIsLoading(false);
      }
    }, 240);

    return () => {
      isCurrent = false;
      window.clearTimeout(timeoutId);
    };
  }, [query]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    setSearchShortcutHint(isMac ? '⌘F' : 'Ctrl+F');
    setBackShortcutHint(isMac ? '⌥←' : 'Alt+←');

    const handleGlobalHotkeys = (event: globalThis.KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key === 'f'
      ) {
        event.preventDefault();
        inputRef.current?.focus();
      } else if (event.altKey && !event.metaKey && !event.ctrlKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        router.history.back();
      }
    };

    window.addEventListener('keydown', handleGlobalHotkeys);
    return () => window.removeEventListener('keydown', handleGlobalHotkeys);
  }, [router]);

  const selectMission = (mission: MissionDto) => {
    void navigate({
      to: '/projects/$projectId/missions/$missionId',
      params: { projectId: mission.projectId, missionId: mission.id }
    });
    setQuery('');
    setResults([]);
    setIsOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!results.length) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIsOpen(true);
      setActiveIndex(prev => Math.min(prev + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(prev => Math.max(prev - 1, 0));
    } else if (event.key === 'Enter' && isOpen) {
      event.preventDefault();
      selectMission(results[activeIndex]);
    } else if (event.key === 'Escape') {
      setIsOpen(false);
    }
  };

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label="Go back"
              onClick={() => router.history.back()}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          }
        />
        <TooltipContent side="bottom">Go back ({backShortcutHint})</TooltipContent>
      </Tooltip>
      <div ref={containerRef} className="relative min-w-0 flex-1">
        <div className="relative">
          <Input
            ref={inputRef}
            placeholder="Search missions…"
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="w-full rounded-lg pr-10 shadow-sm transition-shadow duration-200 ease-in-out focus:shadow-lg"
            role="combobox"
            aria-expanded={isOpen}
            aria-controls={listboxId}
            aria-autocomplete="list"
            onKeyDown={handleKeyDown}
          />
          {!isLoading && (
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {searchShortcutHint}
            </kbd>
          )}
          {isLoading && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              Loading…
            </span>
          )}
        </div>
        {isOpen && results.length > 0 && (
          <ul
            role="listbox"
            id={listboxId}
            className="absolute left-0 top-full z-20 mt-2 w-full overflow-hidden rounded-xl border border-border bg-card shadow-xl"
          >
            {results.map((mission, index) => {
              const isActive = index === activeIndex;
              const projectName = projectNameById.get(mission.projectId);
              return (
                <li
                  key={mission.id}
                  role="option"
                  aria-selected={isActive}
                  className={cn(
                    'px-4 py-3 transition hover:bg-muted/90',
                    isActive ? 'bg-primary/10' : 'bg-card'
                  )}
                  onMouseDown={() => selectMission(mission)}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <p className="truncate text-sm font-medium text-foreground">
                    {mission.title || 'Untitled mission'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {mission.displayId} • {projectName ?? 'Unknown project'}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

import { ChevronDown, ChevronRight, FileCode2, FileText } from 'lucide-react';
import { useState } from 'react';

import type { FileChangeDto } from '../../shared/contract.ts';

import { Badge } from './ui.tsx';

const MARKDOWN_EXTENSIONS = ['.md', '.mdx', '.markdown'];

function isMarkdownFile(name: string): boolean {
  const lower = name.toLowerCase();
  return MARKDOWN_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * A single collapsible file-change entry in the ticket panel's File Changes
 * section. Collapsed it shows the file name and recorded time; expanded it
 * reveals the full path and the structured change/why/impact rationale. Adapted
 * from the reference `LiveFileChangeCard` for this app's stack — there is no
 * editor deep-link or current-changes route here, so the path renders as plain
 * text rather than an external link.
 */
export function LiveFileChangeCard({ fileChange }: { fileChange: FileChangeDto }) {
  const [expanded, setExpanded] = useState(false);
  const isMd = isMarkdownFile(fileChange.fileName || fileChange.filePath);

  return (
    <article className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]">
      <button
        type="button"
        className={`flex w-full items-center gap-2 p-3 text-left transition-colors hover:bg-[var(--color-surface-2)] ${
          expanded ? 'bg-[var(--color-surface-2)]' : ''
        }`}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-ink-dim)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-ink-dim)]" />
        )}
        {isMd ? (
          <FileText className="h-4 w-4 shrink-0 text-sky-500" />
        ) : (
          <FileCode2 className="h-4 w-4 shrink-0 text-[var(--color-ink-dim)]" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-ink)]">
          {fileChange.fileName}
        </span>
        {fileChange.vcsStatus && (
          <Badge className="shrink-0 px-2 py-0 text-[10px] uppercase tracking-wide">
            {fileChange.vcsStatus}
          </Badge>
        )}
        <span className="shrink-0 text-[11px] text-[var(--color-ink-dim)]">
          {formatTimestamp(fileChange.createdAt)}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--color-border)] px-3 pb-3 pt-2">
          <p className="mb-2 break-all text-xs text-[var(--color-ink-dim)]">
            {fileChange.filePath}
          </p>
          <div className="grid gap-2 text-sm">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-[var(--color-ink-dim)]">
                Change
              </p>
              <p className="text-[var(--color-ink)]">{fileChange.label}</p>
              <p className="mt-1 text-[var(--color-ink-dim)]">{fileChange.summary}</p>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-[var(--color-ink-dim)]">
                  Why
                </p>
                <p className="text-[var(--color-ink)]">{fileChange.why}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-[var(--color-ink-dim)]">
                  Impact
                </p>
                <p className="text-[var(--color-ink)]">{fileChange.impact}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

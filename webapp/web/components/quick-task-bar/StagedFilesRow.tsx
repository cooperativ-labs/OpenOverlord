import { X } from 'lucide-react';

import type { StagedFile } from './quick-task-helpers';

type StagedFilesRowProps = {
  stagedFiles: StagedFile[];
  onRemoveFile: (id: string) => void;
};

export function StagedFilesRow({ stagedFiles, onRemoveFile }: StagedFilesRowProps) {
  if (stagedFiles.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {stagedFiles.map(({ id, file }) => (
        <span
          key={id}
          className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
        >
          <span className="truncate">{file.name}</span>
          <button
            type="button"
            onClick={() => onRemoveFile(id)}
            className="text-muted-foreground hover:text-foreground"
            aria-label={`Remove ${file.name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

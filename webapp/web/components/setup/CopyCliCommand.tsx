import { Check, Copy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useCopyToClipboard } from '@/lib/hooks/use-copy-to-clipboard';

type CopyCliCommandProps = {
  command: string;
  description?: string;
};

export function CopyCliCommand({ command, description }: CopyCliCommandProps) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 rounded-md border bg-muted/60 px-3 py-2 font-mono text-xs">
          {command}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5"
          onClick={() => void copy(command)}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  );
}

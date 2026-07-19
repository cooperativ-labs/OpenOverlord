import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import {
  ATTACH_CONTEXT_FIELDS,
  LAUNCH_VARIABLES,
  type LaunchVariableAvailability,
  type LaunchVariableDefinition
} from '../../../../shared/contract.ts';

const AVAILABILITY_LABEL: Record<LaunchVariableAvailability, string> = {
  plan_build: 'Launch prep',
  terminal_env: 'Agent env',
  attach: 'Attach only'
};

function placeholderToken(name: string): string {
  return `{${name}}`;
}

function VariableRow({
  variable,
  onInsert
}: {
  variable: LaunchVariableDefinition;
  onInsert?: (token: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const token = placeholderToken(variable.name);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can fail in non-secure contexts; still offer insert when wired.
    }
  }

  return (
    <div className="flex flex-col gap-1.5 border-b border-border/60 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{token}</code>
        <div className="flex flex-wrap gap-1">
          {variable.availableAt.map(stage => (
            <Badge key={stage} variant="secondary" className="text-[10px] font-normal">
              {AVAILABILITY_LABEL[stage]}
            </Badge>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={handleCopy}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          {onInsert ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onMouseDown={event => event.preventDefault()}
              onClick={() => onInsert(token)}
            >
              Insert
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{variable.description}</p>
      <p className="font-mono text-[11px] text-muted-foreground/80">
        e.g. {variable.example}
        {variable.format ? ` · ${variable.format}` : ''}
      </p>
    </div>
  );
}

type LaunchVariableLibraryProps = {
  /** When set, each row offers an Insert that appends the token via this callback. */
  onInsert?: (token: string) => void;
};

/**
 * Project Settings surface for the built-in `{VAR}` launch-variable catalog.
 * Lists what Overlord can substitute during launch preparation, and what only
 * appears later at attach time (so users do not expect attach fields in env vars).
 */
export function LaunchVariableLibrary({ onInsert }: LaunchVariableLibraryProps) {
  return (
    <div className="max-w-lg rounded-lg border border-border">
      <Accordion>
        <AccordionItem value="launch-variables" className="border-none px-3">
          <AccordionTrigger className="py-3 text-sm font-medium hover:no-underline">
            Available launch variables
          </AccordionTrigger>
          <AccordionContent className="pb-3">
            <p className="mb-3 text-xs text-muted-foreground">
              Use <code className="font-mono">{'{VARIABLE}'}</code> placeholders in launch
              preparation commands and environment variable values. They are substituted when the
              launch plan is built — after the working directory and project resources are known,
              before the terminal exports env and runs prep commands. User-defined env vars are
              referenced later with shell <code className="font-mono">$NAME</code>, not{' '}
              <code className="font-mono">{'{NAME}'}</code>.
            </p>

            <div className="mb-1 text-xs font-medium text-foreground">Substitutable at launch</div>
            <div>
              {LAUNCH_VARIABLES.map(variable => (
                <VariableRow key={variable.name} variable={variable} onInsert={onInsert} />
              ))}
            </div>

            <div className="mt-4 mb-1 text-xs font-medium text-foreground">
              Attach-only (not for placeholders)
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              These exist on the attach response after the agent starts. They are not available for{' '}
              <code className="font-mono">{'{VAR}'}</code> substitution during launch preparation.
            </p>
            <ul className="space-y-2">
              {ATTACH_CONTEXT_FIELDS.map(field => (
                <li key={field.name} className="text-xs text-muted-foreground">
                  <code className="font-mono text-foreground/80">{field.name}</code>
                  <span className="mt-0.5 block">{field.description}</span>
                </li>
              ))}
            </ul>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

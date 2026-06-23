import {
  Ban,
  CheckCheck,
  CircleSlash,
  Eye,
  type LucideIcon,
  NotebookPen,
  Play
} from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react';

import { Badge as ShadcnBadge } from '@/components/ui/badge';
import { Button as ShadcnButton } from '@/components/ui/button';
import { Card as ShadcnCard } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import type { ObjectiveState, StatusType, MissionPriority } from '../../shared/contract.ts';

// ---- Status / priority vocab → presentation ------------------------------

export interface StatusStyle {
  label: string;
  icon: LucideIcon;
  text: string;
  bg: string;
  rail: string;
}

// Single source of truth for stage → icon/color across the board, list, and
// workflow settings views.
export const STATUS_CONFIG: Record<StatusType, StatusStyle> = {
  draft: {
    label: 'Draft',
    icon: NotebookPen,
    text: 'text-muted-foreground',
    bg: 'bg-muted',
    rail: 'border-l-border'
  },
  execute: {
    label: 'Execute',
    icon: Play,
    text: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-500/15',
    rail: 'border-l-blue-500/40'
  },
  review: {
    label: 'Review',
    icon: Eye,
    text: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-500/15',
    rail: 'border-l-amber-500/40'
  },
  complete: {
    label: 'Complete',
    icon: CheckCheck,
    text: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-500/15',
    rail: 'border-l-emerald-500/40'
  },
  blocked: {
    label: 'Blocked',
    icon: Ban,
    text: 'text-red-600 dark:text-red-400',
    bg: 'bg-red-500/15',
    rail: 'border-l-red-500/40'
  },
  cancelled: {
    label: 'Cancelled',
    icon: CircleSlash,
    text: 'text-zinc-500 dark:text-zinc-400',
    bg: 'bg-zinc-500/15',
    rail: 'border-l-zinc-500/40'
  }
};

export const STATUS_LABEL: Record<StatusType, string> = Object.fromEntries(
  Object.entries(STATUS_CONFIG).map(([type, style]) => [type, style.label])
) as Record<StatusType, string>;

export function statusClasses(type: StatusType): string {
  switch (type) {
    case 'draft':
      return 'bg-slate-500/15 text-slate-600 ring-slate-400/30 dark:text-slate-300';
    case 'execute':
      return 'bg-blue-500/15 text-blue-700 ring-blue-400/30 dark:text-blue-300';
    case 'review':
      return 'bg-amber-500/15 text-amber-700 ring-amber-400/30 dark:text-amber-300';
    case 'complete':
      return 'bg-emerald-500/15 text-emerald-700 ring-emerald-400/30 dark:text-emerald-300';
    case 'blocked':
      return 'bg-red-500/15 text-red-700 ring-red-400/30 dark:text-red-300';
    case 'cancelled':
      return 'bg-zinc-500/15 text-zinc-600 ring-zinc-400/30 dark:text-zinc-400';
  }
}

export const OBJECTIVE_STATE_LABEL: Record<ObjectiveState, string> = {
  future: 'Future',
  draft: 'Draft',
  submitted: 'Submitted',
  launching: 'Launching',
  executing: 'Executing',
  pending_delivery: 'Pending delivery',
  complete: 'Complete'
};

export function objectiveStateClasses(state: ObjectiveState): string {
  switch (state) {
    case 'future':
      return 'bg-zinc-500/15 text-zinc-600 ring-zinc-400/30 dark:text-zinc-400';
    case 'draft':
      return 'bg-slate-500/15 text-slate-600 ring-slate-400/30 dark:text-slate-300';
    case 'submitted':
      return 'bg-indigo-500/15 text-indigo-700 ring-indigo-400/30 dark:text-indigo-300';
    case 'launching':
      return 'bg-cyan-500/15 text-cyan-700 ring-cyan-400/30 dark:text-cyan-300';
    case 'executing':
      return 'bg-blue-500/15 text-blue-700 ring-blue-400/30 dark:text-blue-300';
    case 'pending_delivery':
      return 'bg-amber-500/15 text-amber-700 ring-amber-400/30 dark:text-amber-300';
    case 'complete':
      return 'bg-emerald-500/15 text-emerald-700 ring-emerald-400/30 dark:text-emerald-300';
  }
}

export function priorityClasses(priority: MissionPriority | null): string {
  switch (priority) {
    case 'urgent':
      return 'bg-red-500/15 text-red-700 ring-red-400/30 dark:text-red-300';
    case 'high':
      return 'bg-orange-500/15 text-orange-700 ring-orange-400/30 dark:text-orange-300';
    case 'normal':
      return 'bg-slate-500/15 text-slate-600 ring-slate-400/30 dark:text-slate-300';
    case 'low':
      return 'bg-zinc-500/15 text-zinc-600 ring-zinc-400/30 dark:text-zinc-400';
    default:
      return 'bg-zinc-500/15 text-zinc-600 ring-zinc-400/30 dark:text-zinc-400';
  }
}

// ---- Primitives (shadcn-backed app wrappers) ------------------------------

export function Badge({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <ShadcnBadge variant="outline" className={cn('rounded-full ring-1 ring-inset', className)}>
      {children}
    </ShadcnBadge>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonVariantMap: Record<ButtonVariant, ComponentProps<typeof ShadcnButton>['variant']> = {
  primary: 'default',
  secondary: 'secondary',
  ghost: 'ghost',
  danger: 'destructive'
};

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <ShadcnButton variant={buttonVariantMap[variant]} className={className} {...props} />;
}

export function Card({
  children,
  className = '',
  onClick
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <ShadcnCard
      onClick={onClick}
      className={cn(onClick && 'cursor-pointer transition hover:ring-primary/50', className)}
    >
      {children}
    </ShadcnCard>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <Input className={className} {...rest} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props;
  return <Textarea className={className} {...rest} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', ...rest } = props;
  return (
    <select
      className={cn(
        'h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30',
        className
      )}
      {...rest}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

export function Modal({
  title,
  open,
  onClose,
  children
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={next => !next && onClose()}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg" showCloseButton>
        <DialogHeader className="border-b px-5 py-3">
          <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
        </DialogHeader>
        <div className="p-5">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

export function EmptyState({
  title,
  hint,
  action
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint && <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-primary" />
      {label ?? 'Loading…'}
    </div>
  );
}

// Inline click-to-edit text now lives in its own component; import it from
// `./InlineEditField` (exported as `InlineEditField`, with an `EditableText`
// backwards-compatible alias).

import * as React from 'react';

import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

function FieldGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="field-group" className={cn('flex flex-col gap-6', className)} {...props} />
  );
}

function Field({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<'div'> & { orientation?: 'vertical' | 'horizontal' }) {
  return (
    <div
      data-slot="field"
      role="group"
      className={cn(
        orientation === 'vertical' && 'grid gap-2',
        orientation === 'horizontal' && 'flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4',
        className
      )}
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return <Label data-slot="field-label" className={cn(className)} {...props} />;
}

function FieldDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

function FieldSeparator({ className, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-separator"
      className={cn('flex items-center gap-4', className)}
      {...props}
    >
      <Separator className="flex-1" />
      {children ? <span className="text-sm text-muted-foreground">{children}</span> : null}
      <Separator className="flex-1" />
    </div>
  );
}

export { Field, FieldDescription, FieldGroup, FieldLabel, FieldSeparator };

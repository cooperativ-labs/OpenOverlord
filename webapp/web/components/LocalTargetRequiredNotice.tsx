export function LocalTargetRequiredNotice({ className }: { className?: string }) {
  return (
    <p className={className ?? 'text-xs text-muted-foreground'}>
      Open <span className="font-medium text-foreground">Overlord Desktop</span> to run git
      operations on linked checkouts from this machine.
    </p>
  );
}

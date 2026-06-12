import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type WorkspaceCreationFieldsProps = {
  name: string;
  onNameChange: (name: string) => void;
  slug: string;
  onSlugChange: (value: string) => void;
  exampleSlug: string;
  nameInputId: string;
  slugInputId: string;
  namePlaceholder?: string;
  onEnter?: () => void;
};

export function WorkspaceCreationFields({
  name,
  onNameChange,
  slug,
  onSlugChange,
  exampleSlug,
  nameInputId,
  slugInputId,
  namePlaceholder = 'e.g. Acme Engineering',
  onEnter
}: WorkspaceCreationFieldsProps) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={nameInputId}>Workspace name</Label>
        <Input
          id={nameInputId}
          autoFocus
          value={name}
          onChange={e => onNameChange(e.target.value)}
          placeholder={namePlaceholder}
          onKeyDown={e => {
            if (e.key === 'Enter') onEnter?.();
          }}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={slugInputId}>Workspace slug</Label>
        <Input
          id={slugInputId}
          value={slug}
          onChange={e => onSlugChange(e.target.value)}
          placeholder="abc"
          className="font-mono"
          onKeyDown={e => {
            if (e.key === 'Enter') onEnter?.();
          }}
        />
        <p className="text-xs text-muted-foreground">
          Suggested from the first three letters of the workspace name.
        </p>
      </div>

      <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
        <p className="text-muted-foreground">Tickets in this workspace will be identified as</p>
        <p className="mt-1 font-mono text-foreground">
          {exampleSlug}:1, {exampleSlug}:2, {exampleSlug}:3, …
        </p>
      </div>
    </>
  );
}

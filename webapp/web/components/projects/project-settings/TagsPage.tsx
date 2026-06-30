import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  DEFAULT_PROJECT_COLOR,
  ProjectColorSetter
} from '@/components/projects/ProjectColorSetter';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useCreateProjectTag,
  useDeleteProjectTag,
  useProjectTags,
  useUpdateProjectTag
} from '@/lib/queries';

import type { ProjectTagDto } from '../../../../shared/contract.ts';

type TagsPageProps = {
  projectId: string;
};

export function TagsPage({ projectId }: TagsPageProps) {
  const tagsQ = useProjectTags(projectId);
  const tags = tagsQ.data ?? [];
  const createTag = useCreateProjectTag(projectId);
  const updateTag = useUpdateProjectTag(projectId);
  const deleteTag = useDeleteProjectTag(projectId);

  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_PROJECT_COLOR);
  const [addError, setAddError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectTagDto | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleRename(tag: ProjectTagDto, label: string) {
    const trimmed = label.trim();
    if (!trimmed || trimmed === tag.label) return;
    setRowError(null);
    try {
      await updateTag.mutateAsync({ tagId: tag.id, body: { label: trimmed } });
    } catch (error) {
      setRowError(error instanceof Error ? error.message : 'Failed to rename tag.');
    }
  }

  async function handleRecolor(tag: ProjectTagDto, color: string) {
    if (color === tag.color) return;
    setRowError(null);
    try {
      await updateTag.mutateAsync({ tagId: tag.id, body: { color } });
    } catch (error) {
      setRowError(error instanceof Error ? error.message : 'Failed to update tag color.');
    }
  }

  async function handleToggleActive(tag: ProjectTagDto) {
    setRowError(null);
    try {
      await updateTag.mutateAsync({ tagId: tag.id, body: { active: !tag.active } });
    } catch (error) {
      setRowError(error instanceof Error ? error.message : 'Failed to update tag.');
    }
  }

  async function handleAddTag() {
    const trimmed = newLabel.trim();
    if (!trimmed) {
      setAddError('Enter a tag label.');
      return;
    }
    setAddError(null);
    try {
      await createTag.mutateAsync({ label: trimmed, color: newColor });
      setNewLabel('');
      setNewColor(DEFAULT_PROJECT_COLOR);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : 'Failed to add tag.');
    }
  }

  async function handleDeleteTag() {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      await deleteTag.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Failed to delete tag.');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Tags</h2>
        <p className="text-sm text-muted-foreground">
          Labels you can attach to missions in this project. Tags appear in the mission-create
          picker, the board tag filter, and the tag button on mission cards. Inactive tags are
          hidden from new missions but kept on existing ones.
        </p>
      </div>

      {tags.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tags yet.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Color</th>
                <th className="px-3 py-2 font-medium">Label</th>
                <th className="px-3 py-2 font-medium">Active</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {tags.map(tag => (
                <tr key={tag.id} className="border-t">
                  <td className="px-3 py-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        disabled={updateTag.isPending}
                        render={
                          <button
                            type="button"
                            className="h-5 w-5 shrink-0 rounded border transition hover:ring-2 hover:ring-primary hover:ring-offset-2 disabled:opacity-50"
                            style={{
                              backgroundColor: tag.color ?? DEFAULT_PROJECT_COLOR,
                              borderColor: tag.color ?? DEFAULT_PROJECT_COLOR
                            }}
                            aria-label={`Color for ${tag.label}`}
                          />
                        }
                      />
                      <DropdownMenuContent className="w-auto p-2" align="start">
                        <ProjectColorSetter
                          value={tag.color ?? DEFAULT_PROJECT_COLOR}
                          onSelect={color => void handleRecolor(tag, color)}
                        />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      defaultValue={tag.label}
                      className="h-8"
                      disabled={updateTag.isPending}
                      onBlur={event => void handleRename(tag, event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={tag.active ? 'secondary' : 'ghost'}
                      className="h-7"
                      disabled={updateTag.isPending}
                      onClick={() => void handleToggleActive(tag)}
                    >
                      {tag.active ? 'Active' : 'Inactive'}
                    </Button>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7 text-destructive hover:text-destructive"
                      onClick={() => {
                        setDeleteError(null);
                        setDeleteTarget(tag);
                      }}
                      aria-label={`Delete ${tag.label}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rowError ? <p className="text-xs text-destructive">{rowError}</p> : null}

      <div className="rounded-lg border p-4">
        <h3 className="text-sm font-medium">Add tag</h3>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label>Color</Label>
            <ProjectColorSetter value={newColor} onSelect={setNewColor} />
          </div>
          <div className="grid min-w-[12rem] gap-1.5">
            <Label htmlFor="new-tag-label">Label</Label>
            <Input
              id="new-tag-label"
              value={newLabel}
              onChange={event => setNewLabel(event.target.value)}
              placeholder="e.g. Bug"
              className="h-8"
              onKeyDown={event => {
                if (event.key === 'Enter') void handleAddTag();
              }}
            />
          </div>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5"
            disabled={createTag.isPending}
            onClick={() => void handleAddTag()}
          >
            <Plus className="size-3.5" />
            Add tag
          </Button>
        </div>
        {addError ? <p className="mt-2 text-xs text-destructive">{addError}</p> : null}
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={open => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete tag</DialogTitle>
            <DialogDescription>
              Remove &ldquo;{deleteTarget?.label}&rdquo; from this project? It will also be removed
              from any missions that carry it.
            </DialogDescription>
          </DialogHeader>
          {deleteError ? <p className="text-sm text-destructive">{deleteError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteTag.isPending}
              onClick={() => void handleDeleteTag()}
            >
              Delete tag
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

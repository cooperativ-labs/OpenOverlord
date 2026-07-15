import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { AgentIcon } from '@/components/objectives/AgentIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useAgentCatalog, useRefreshAgentCatalog, useUpdateAgentCatalog } from '@/lib/queries';
import { cn } from '@/lib/utils';

import type { AgentCatalogAgentDto, AgentCatalogDto } from '../../../../shared/contract.ts';

type DraftAgent = AgentCatalogAgentDto;

function cloneCatalogAgents(catalog: AgentCatalogDto): DraftAgent[] {
  return catalog.agents.map(agent => ({
    ...agent,
    models: agent.models.map(model => ({
      ...model,
      enabled: model.enabled ?? true,
      reasoningOptions: [...model.reasoningOptions]
    }))
  }));
}

function catalogsEqual(left: DraftAgent[], right: DraftAgent[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reasoningOptionsToInput(options: string[]): string {
  return options.join(', ');
}

function reasoningOptionsFromInput(value: string): string[] {
  return value
    .split(',')
    .map(option => option.trim())
    .filter(option => option.length > 0);
}

function createModelRowKey(): string {
  return `model-row-${crypto.randomUUID()}`;
}

function SortableModelRow({
  agentKey,
  rowKey,
  model,
  onChange,
  onDelete,
  disabled
}: {
  agentKey: string;
  rowKey: string;
  model: DraftAgent['models'][number];
  onChange: (next: DraftAgent['models'][number]) => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: rowKey });

  return (
    <tr
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('border-t', isDragging && 'z-10 bg-muted/30 opacity-70')}
    >
      <td className="w-8 px-2 py-2">
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={`Reorder ${model.displayName}`}
          disabled={disabled}
          className="flex size-7 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
      </td>
      <td className="px-3 py-2 text-center">
        <input
          type="checkbox"
          aria-label={`Offer ${model.displayName} as a selectable option`}
          checked={model.enabled ?? true}
          disabled={disabled}
          className="size-4 cursor-pointer rounded border-input accent-primary disabled:cursor-not-allowed disabled:opacity-40"
          onChange={event => onChange({ ...model, enabled: event.target.checked })}
        />
      </td>
      <td className="px-3 py-2">
        <Input
          value={model.id}
          className="h-8 font-mono text-xs"
          disabled={disabled}
          onChange={event => onChange({ ...model, id: event.target.value })}
        />
      </td>
      <td className="px-3 py-2">
        <Input
          value={model.displayName}
          className="h-8"
          disabled={disabled}
          onChange={event => onChange({ ...model, displayName: event.target.value })}
        />
      </td>
      <td className="px-3 py-2">
        <Input
          value={reasoningOptionsToInput(model.reasoningOptions)}
          className="h-8 font-mono text-xs"
          placeholder="low, medium, high"
          disabled={disabled}
          onChange={event =>
            onChange({ ...model, reasoningOptions: reasoningOptionsFromInput(event.target.value) })
          }
        />
      </td>
      <td className="px-3 py-2 text-right">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 text-destructive hover:text-destructive"
          disabled={disabled}
          onClick={onDelete}
          aria-label={`Delete ${model.displayName} from ${agentKey}`}
        >
          <Trash2 className="size-4" />
        </Button>
      </td>
    </tr>
  );
}

function AgentModelsSection({
  agent,
  onChange,
  disabled
}: {
  agent: DraftAgent;
  onChange: (next: DraftAgent) => void;
  disabled: boolean;
}) {
  const [modelOrder, setModelOrder] = useState(() => agent.models.map(() => createModelRowKey()));

  useEffect(() => {
    setModelOrder(previous => {
      if (previous.length === agent.models.length) return previous;
      if (previous.length < agent.models.length) {
        const additions = Array.from({ length: agent.models.length - previous.length }, () =>
          createModelRowKey()
        );
        return [...previous, ...additions];
      }
      return previous.slice(0, agent.models.length);
    });
  }, [agent.models.length]);

  const orderedModels = useMemo(() => {
    return modelOrder
      .map((rowKey, index) => {
        const model = agent.models[index];
        return model ? { rowKey, model } : null;
      })
      .filter((entry): entry is { rowKey: string; model: DraftAgent['models'][number] } =>
        Boolean(entry)
      );
  }, [agent.models, modelOrder]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function updateModels(models: DraftAgent['models']) {
    onChange({ ...agent, models });
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = modelOrder.indexOf(String(active.id));
    const newIndex = modelOrder.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;

    const nextOrder = arrayMove(modelOrder, oldIndex, newIndex);
    setModelOrder(nextOrder);
    updateModels(arrayMove(agent.models, oldIndex, newIndex));
  }

  function handleAddModel() {
    const suffix = agent.models.length + 1;
    const id = `model-${suffix}`;
    setModelOrder(previous => [...previous, createModelRowKey()]);
    updateModels([
      ...agent.models,
      { id, displayName: `Model ${suffix}`, reasoningOptions: [], enabled: true }
    ]);
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <AgentIcon agentKey={agent.key} size={16} alt={agent.label} />
            <h3 className="text-sm font-medium">{agent.label}</h3>
            <span className="font-mono text-xs text-muted-foreground">{agent.key}</span>
          </div>
          <p className="text-sm text-muted-foreground">
            Drag rows to set the model order shown in launch pickers.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={`${agent.key}-available`} className="text-xs text-muted-foreground">
            Offered by default
          </Label>
          <Switch
            id={`${agent.key}-available`}
            checked={agent.availableByDefault}
            disabled={disabled}
            onCheckedChange={availableByDefault => onChange({ ...agent, availableByDefault })}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor={`${agent.key}-label`}>Display label</Label>
          <Input
            id={`${agent.key}-label`}
            value={agent.label}
            className="h-8"
            disabled={disabled}
            onChange={event => onChange({ ...agent, label: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${agent.key}-default-model`}>Default model</Label>
          <Select
            value={agent.defaultModel ?? '__none__'}
            disabled={disabled}
            onValueChange={value =>
              onChange({ ...agent, defaultModel: value === '__none__' ? null : value })
            }
          >
            <SelectTrigger id={`${agent.key}-default-model`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">None</SelectItem>
              {orderedModels
                .filter(({ model }) => model.enabled !== false)
                .map(({ model }) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.displayName}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${agent.key}-reasoning-label`}>Reasoning column label</Label>
          <Input
            id={`${agent.key}-reasoning-label`}
            value={agent.reasoningLabel}
            className="h-8"
            disabled={disabled}
            onChange={event => onChange({ ...agent, reasoningLabel: event.target.value })}
          />
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-8 px-2 py-2" />
                <th className="px-3 py-2 text-center font-medium">Offer</th>
                <th className="px-3 py-2 font-medium">Model id</th>
                <th className="px-3 py-2 font-medium">Display name</th>
                <th className="px-3 py-2 font-medium">Reasoning options</th>
                <th className="px-3 py-2 text-right font-medium">Remove</th>
              </tr>
            </thead>
            <tbody>
              <SortableContext items={modelOrder} strategy={verticalListSortingStrategy}>
                {orderedModels.map(({ rowKey, model }, index) => (
                  <SortableModelRow
                    key={rowKey}
                    rowKey={rowKey}
                    agentKey={agent.key}
                    model={model}
                    disabled={disabled}
                    onChange={next => {
                      updateModels(
                        agent.models.map((existing, i) => (i === index ? next : existing))
                      );
                    }}
                    onDelete={() => {
                      setModelOrder(previous => previous.filter((_, i) => i !== index));
                      updateModels(agent.models.filter((_, i) => i !== index));
                    }}
                  />
                ))}
              </SortableContext>
            </tbody>
          </table>
        </DndContext>
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={handleAddModel}
      >
        <Plus className="mr-1 size-4" />
        Add model
      </Button>
    </div>
  );
}

type ModelsPageProps = {
  open: boolean;
  /** The workspace whose catalog is being managed — not necessarily the active one (coo:324). */
  workspaceId: string;
};

export function ModelsPage({ open, workspaceId }: ModelsPageProps) {
  const catalog = useAgentCatalog(workspaceId);
  const refreshCatalog = useRefreshAgentCatalog(workspaceId);
  const updateCatalog = useUpdateAgentCatalog(workspaceId);

  const [draftAgents, setDraftAgents] = useState<DraftAgent[]>([]);
  const [savedAgents, setSavedAgents] = useState<DraftAgent[]>([]);
  const [jsonDraft, setJsonDraft] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<ButtonLoadingState>('default');
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !catalog.data) return;
    const next = cloneCatalogAgents(catalog.data);
    setDraftAgents(next);
    setSavedAgents(next);
    setJsonDraft(JSON.stringify({ agents: next }, null, 2));
    setJsonError(null);
    setSaveError(null);
    setSaveState('default');
  }, [open, catalog.data]);

  const isDirty = !catalogsEqual(draftAgents, savedAgents);

  useEffect(() => {
    if (!open) return;
    setJsonDraft(JSON.stringify({ agents: draftAgents }, null, 2));
  }, [draftAgents, open]);

  if (!open) return null;

  if (catalog.isLoading && !catalog.data) {
    return <p className="text-sm text-muted-foreground">Loading model catalog…</p>;
  }

  if (catalog.isError || !catalog.data) {
    return (
      <p className="text-sm text-destructive">
        {(catalog.error as Error | undefined)?.message ?? 'Model catalog is unavailable right now.'}
      </p>
    );
  }

  async function handleSave() {
    setSaveState('loading');
    setSaveError(null);
    try {
      const updated = await updateCatalog.mutateAsync({ agents: draftAgents });
      const next = cloneCatalogAgents(updated);
      setDraftAgents(next);
      setSavedAgents(next);
      setSaveState('success');
    } catch (error) {
      setSaveState('error');
      setSaveError(error instanceof Error ? error.message : 'Failed to save model catalog.');
    }
  }

  function applyJsonDraft() {
    setJsonError(null);
    try {
      const parsed = JSON.parse(jsonDraft) as { agents?: DraftAgent[] };
      if (!parsed || !Array.isArray(parsed.agents)) {
        throw new Error('JSON must contain an agents array.');
      }
      setDraftAgents(parsed.agents);
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : 'Invalid JSON.');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">Models</h2>
          <p className="text-sm text-muted-foreground">
            Configure which agents and models are offered in this workspace. Stored in{' '}
            <code className="font-mono text-xs">workspaces.settings_json.agentCatalog</code>.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={refreshCatalog.isPending || updateCatalog.isPending}
          onClick={() => void refreshCatalog.mutateAsync()}
        >
          {refreshCatalog.isPending ? 'Refreshing…' : 'Merge bundled defaults'}
        </Button>
      </div>

      {draftAgents.map((agent, index) => (
        <div key={agent.key} className="space-y-4">
          {index > 0 ? <Separator /> : null}
          <AgentModelsSection
            agent={agent}
            disabled={updateCatalog.isPending}
            onChange={next =>
              setDraftAgents(previous =>
                previous.map(existing => (existing.key === next.key ? next : existing))
              )
            }
          />
        </div>
      ))}

      <div className="space-y-3 rounded-lg border p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Catalog JSON</h3>
          <p className="text-sm text-muted-foreground">
            Edit the stored catalog directly. Apply parses the JSON into the form above.
          </p>
        </div>
        <Textarea
          value={jsonDraft}
          rows={14}
          className="min-h-48 resize-y font-mono text-xs"
          disabled={updateCatalog.isPending}
          onChange={event => setJsonDraft(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={applyJsonDraft}>
            Apply JSON
          </Button>
          {jsonError ? <p className="text-xs text-destructive">{jsonError}</p> : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <LoadingButton
          buttonState={saveState}
          setButtonState={setSaveState}
          text="Save catalog"
          loadingText="Saving…"
          successText="Saved"
          errorText="Retry"
          reset
          size="sm"
          disabled={!isDirty}
          onClick={() => void handleSave()}
        />
        {isDirty ? <p className="text-xs text-muted-foreground">Unsaved changes</p> : null}
      </div>
      {saveError ? <p className="text-sm text-destructive">{saveError}</p> : null}
    </div>
  );
}

import { BUNDLED_AGENT_CATALOG, type CatalogAgent } from './agent-catalog-defaults.ts';

type TomlCatalogModel = {
  id?: string;
  display_name?: string;
  reasoning_options?: string[];
};

type TomlCatalogAgent = {
  label?: string;
  available_by_default?: boolean;
  default_model?: string;
  default_reasoning_effort?: string;
  reasoning_label?: string;
  models?: TomlCatalogModel[];
};

function emptyToNull(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  return value;
}

export function parseAgentCatalogFromToml(raw: unknown): Record<string, CatalogAgent> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const agents: Record<string, CatalogAgent> = {};
  for (const [key, entry] of Object.entries(raw as Record<string, TomlCatalogAgent>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const models = (entry.models ?? [])
      .filter((model): model is TomlCatalogModel & { id: string } => {
        return Boolean(model && typeof model === 'object' && typeof model.id === 'string');
      })
      .map(model => ({
        id: model.id,
        displayName: model.display_name?.trim() || model.id,
        reasoningOptions: Array.isArray(model.reasoning_options)
          ? model.reasoning_options.filter((option): option is string => typeof option === 'string')
          : []
      }));

    if (!entry.label?.trim() || models.length === 0) continue;

    agents[key] = {
      label: entry.label.trim(),
      availableByDefault: entry.available_by_default !== false,
      models,
      defaultModel: emptyToNull(entry.default_model),
      defaultReasoningEffort: emptyToNull(entry.default_reasoning_effort),
      reasoningLabel: entry.reasoning_label?.trim() || 'Thinking'
    };
  }

  return Object.keys(agents).length > 0 ? agents : null;
}

function mergeAgentCatalogs({
  base,
  overrides
}: {
  base: Record<string, CatalogAgent>;
  overrides: Record<string, CatalogAgent>;
}): Record<string, CatalogAgent> {
  const merged = structuredClone(base);

  for (const [key, override] of Object.entries(overrides)) {
    const existing = merged[key];
    if (!existing) {
      merged[key] = structuredClone(override);
      continue;
    }

    const modelsById = new Map(existing.models.map(model => [model.id, model]));
    for (const model of override.models) {
      modelsById.set(model.id, model);
    }

    merged[key] = {
      ...existing,
      ...override,
      models: Array.from(modelsById.values())
    };
  }

  return merged;
}

/** Instance catalog: bundled defaults merged with optional overlord.toml overrides. */
export function resolveInstanceAgentCatalog({
  configCatalog
}: {
  configCatalog: Record<string, CatalogAgent> | null;
}): Record<string, CatalogAgent> {
  if (!configCatalog) {
    return structuredClone(BUNDLED_AGENT_CATALOG);
  }
  return mergeAgentCatalogs({ base: BUNDLED_AGENT_CATALOG, overrides: configCatalog });
}

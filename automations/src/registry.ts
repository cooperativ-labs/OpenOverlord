import { manageObjectiveLifecycleTool } from './objective-manager/index.js';
import { summarizeObjectiveTitleTool, summarizeTextTool } from './title-summarizer/index.js';
import type { Automation, AutomationRunContext } from './types.js';

export type RegisteredAutomation = {
  id: string;
  label: string;
  description: string;
  run: (params: { input: unknown; context?: AutomationRunContext }) => Promise<unknown>;
};

function asRegisteredAutomation<TInput, TOutput>(
  automation: Automation<TInput, TOutput>
): RegisteredAutomation {
  return {
    id: automation.id,
    label: automation.label,
    description: automation.description,
    run: params =>
      automation.run({
        input: params.input as TInput,
        ...(params.context ? { context: params.context } : {})
      })
  };
}

const builtInAutomations: RegisteredAutomation[] = [
  asRegisteredAutomation(manageObjectiveLifecycleTool),
  asRegisteredAutomation(summarizeTextTool),
  asRegisteredAutomation(summarizeObjectiveTitleTool)
];

const automationsById = new Map<string, RegisteredAutomation>(
  builtInAutomations.map(automation => [automation.id, automation])
);

export function listAutomations(): ReadonlyArray<RegisteredAutomation> {
  return [...automationsById.values()];
}

export function getAutomation(automationId: string): RegisteredAutomation | undefined {
  return automationsById.get(automationId);
}

export function registerAutomation(automation: RegisteredAutomation): void {
  if (automationsById.has(automation.id)) {
    throw new Error(`Automation "${automation.id}" is already registered.`);
  }

  automationsById.set(automation.id, automation);
}

export function registerTypedAutomation<TInput, TOutput>(
  automation: Automation<TInput, TOutput>
): void {
  registerAutomation(asRegisteredAutomation(automation));
}

/** Register several automations at once. Convenience over repeated `registerAutomation`. */
export function registerAutomations(automations: ReadonlyArray<RegisteredAutomation>): void {
  for (const automation of automations) {
    registerAutomation(automation);
  }
}

const loadedModuleSpecs = new Set<string>();
const importExternalAutomationModule = new Function('specifier', 'return import(specifier);') as (
  specifier: string
) => Promise<unknown>;

/**
 * Downstream extension seam (`custom-automation` extension point). Imports the
 * module(s) named by `OVERLORD_AUTOMATIONS_MODULE` (comma-separated package
 * names or paths) purely for their side effects: each module is expected to
 * call `registerAutomation` / `registerAutomations` at import time.
 *
 * This exists so a fork that tracks OpenOverlord upstream can inject its own
 * automations **without editing `builtInAutomations` above** — that array is the
 * one line guaranteed to conflict on every upstream merge. A fork instead points
 * the env var at its own bundle and never touches this file.
 *
 * Idempotent per module specifier; a missing/blank env var is a no-op. Returns
 * the ids newly registered by this call (for boot logging).
 */
export async function loadExternalAutomations(
  env: NodeJS.ProcessEnv = process.env
): Promise<ReadonlyArray<string>> {
  const raw = env.OVERLORD_AUTOMATIONS_MODULE?.trim();
  if (!raw) return [];

  const specs = raw
    .split(',')
    .map(spec => spec.trim())
    .filter(spec => spec.length > 0);

  const newlyRegistered: string[] = [];
  for (const spec of specs) {
    if (loadedModuleSpecs.has(spec)) continue;
    loadedModuleSpecs.add(spec);

    const before = new Set(automationsById.keys());
    await importExternalAutomationModule(spec);
    for (const id of automationsById.keys()) {
      if (!before.has(id)) newlyRegistered.push(id);
    }
  }

  return newlyRegistered;
}

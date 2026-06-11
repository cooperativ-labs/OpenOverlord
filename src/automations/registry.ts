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

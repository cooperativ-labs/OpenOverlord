export type AutomationRunContext = {
  logPrefix?: string;
};

export type Automation<TInput, TOutput> = {
  id: string;
  label: string;
  description: string;
  run: (params: { input: TInput; context?: AutomationRunContext }) => Promise<TOutput | null>;
};

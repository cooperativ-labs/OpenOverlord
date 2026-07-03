/** Bundled workspace agent catalog seeded when overlord.toml has no [agent_catalog]. */
export type CatalogAgent = {
  label: string;
  availableByDefault: boolean;
  models: Array<{ id: string; displayName: string; reasoningOptions: string[] }>;
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
  reasoningLabel: string;
};

export const BUNDLED_AGENT_CATALOG: Record<string, CatalogAgent> = {
  claude: {
    label: 'Claude Code',
    availableByDefault: true,
    models: [
      {
        id: 'claude-fable-5',
        displayName: 'Fable 5',
        reasoningOptions: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
      },
      {
        id: 'claude-opus-4-8',
        displayName: 'Opus 4.8',
        reasoningOptions: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
      },
      {
        id: 'claude-sonnet-5',
        displayName: 'Sonnet 5',
        reasoningOptions: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
      },
      {
        id: 'claude-sonnet-4-6',
        displayName: 'Sonnet 4.6',
        reasoningOptions: ['low', 'medium', 'high', 'max']
      },
      { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5', reasoningOptions: [] }
    ],
    defaultModel: null,
    defaultReasoningEffort: null,
    reasoningLabel: 'Thinking'
  },
  codex: {
    label: 'Codex',
    availableByDefault: true,
    models: [
      {
        id: 'gpt-5.4',
        displayName: 'GPT-5.4',
        reasoningOptions: ['low', 'medium', 'high', 'xhigh']
      },

      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        reasoningOptions: ['low', 'medium', 'high', 'xhigh']
      }
    ],
    defaultModel: 'gpt-5.4',
    defaultReasoningEffort: 'medium',
    reasoningLabel: 'Effort'
  },
  cursor: {
    label: 'Cursor',
    availableByDefault: true,
    models: [
      { id: 'auto', displayName: 'Auto', reasoningOptions: [] },
      { id: 'composer-2.5', displayName: 'Composer 2.5', reasoningOptions: [] }
    ],
    defaultModel: 'auto',
    defaultReasoningEffort: null,
    reasoningLabel: 'Thinking'
  }
};

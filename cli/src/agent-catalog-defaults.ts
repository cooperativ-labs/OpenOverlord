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
      },
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        reasoningOptions: ['low', 'medium', 'high', 'xhigh', 'max']
      },
      {
        id: 'gpt-5.6-luna',
        displayName: 'GPT-5.6 Luna',
        reasoningOptions: ['low', 'medium', 'high', 'xhigh', 'max']
      },
      {
        id: 'gpt-5.6-terra',
        displayName: 'GPT-5.6 Terra',
        reasoningOptions: ['none', 'low', 'medium', 'high', 'xhigh', 'max']
      }
    ],
    defaultModel: 'gpt-5.4',
    defaultReasoningEffort: 'medium',
    reasoningLabel: 'Effort'
  },
  pi: {
    label: 'PI',
    availableByDefault: true,
    models: [
      {
        id: 'zai/glm-5.2',
        displayName: 'GLM 5.2',
        reasoningOptions: ['off', 'high', 'max']
      },
      {
        id: 'anthropic/claude-opus-4-8',
        displayName: 'Claude Opus 4.8',
        reasoningOptions: ['low', 'medium', 'high', 'xhigh', 'max']
      },
      {
        id: 'openai-codex/gpt-5.6-terra',
        displayName: 'GPT-5.6 Terra',
        reasoningOptions: ['off', 'low', 'medium', 'high', 'xhigh', 'max']
      }
    ],
    defaultModel: null,
    defaultReasoningEffort: null,
    reasoningLabel: 'Thinking'
  },
  cursor: {
    label: 'Cursor',
    availableByDefault: true,
    models: [
      { id: 'auto', displayName: 'Auto', reasoningOptions: [] },
      { id: 'composer-2.5', displayName: 'Composer 2.5', reasoningOptions: [] },
      {
        id: 'grok-4.5-fast-high',
        displayName: 'Grok 4.5 Fast High',
        reasoningOptions: []
      },
      {
        id: 'grok-4.5-fast-medium',
        displayName: 'Grok 4.5 Fast Medium',
        reasoningOptions: []
      },
      {
        id: 'grok-4.5-fast-xhigh',
        displayName: 'Grok 4.5 Fast Xhigh',
        reasoningOptions: []
      },
      {
        id: 'grok-4.5-high',
        displayName: 'Grok 4.5 High',
        reasoningOptions: []
      },
      {
        id: 'grok-4.5-medium',
        displayName: 'Grok 4.5 Medium',
        reasoningOptions: []
      },
      {
        id: 'grok-4.5-xhigh',
        displayName: 'Grok 4.5 Xhigh',
        reasoningOptions: []
      },
      {
        id: 'glm-5.2-high',
        displayName: 'GLM 5.2 High',
        reasoningOptions: []
      },
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        reasoningOptions: []
      },

      {
        id: 'gpt-5.6-terra',
        displayName: 'GPT-5.6 Terra',
        reasoningOptions: []
      },
      {
        id: 'gpt-5.6-luna',
        displayName: 'GPT-5.6 Luna',
        reasoningOptions: []
      }
    ],
    defaultModel: 'auto',
    defaultReasoningEffort: null,
    reasoningLabel: 'Thinking'
  }
};

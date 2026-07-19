import type { Automation } from '../types.js';

import {
  type ComposeDeliveryDraft,
  type ComposeDeliveryInput,
  composeDeliveryWithGemini
} from './compose.js';

export type {
  ComposeDeliveryDraft,
  ComposeDeliveryEvidenceItem,
  ComposeDeliveryInput
} from './compose.js';
export {
  buildComposeDeliveryPrompt,
  COMPOSE_DELIVERY_RESPONSE_SCHEMA,
  composeDeliveryWithGemini,
  resetGeminiClientForTests
} from './compose.js';

export const composeDeliveryTool: Automation<ComposeDeliveryInput, ComposeDeliveryDraft> = {
  id: 'compose-delivery',
  label: 'Compose delivery presentation',
  description:
    'Uses Gemini to polish a delivery Markdown presentation and structured callouts from agent evidence.',
  run: async ({ input, context }) =>
    composeDeliveryWithGemini({
      input,
      logPrefix: context?.logPrefix ?? '[automations/compose-delivery]'
    })
};

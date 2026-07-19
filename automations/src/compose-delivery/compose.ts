import { type Schema, Type } from '@google/genai';

import { readGeminiConfigFromEnv } from '../title-summarizer/config.js';
import { getGeminiClient, resetGeminiClientForTests } from '../title-summarizer/gemini-client.js';

export { resetGeminiClientForTests };

export type ComposeDeliveryEvidenceItem = {
  id: string;
  action?: string;
  decision?: string;
  reason?: string;
  rationale?: string;
  impact?: string;
  category?: string;
  alternativesConsidered?: string[];
  source: string;
  sourceRef?: string;
};

export type ComposeDeliveryInput = {
  summary: string;
  objectiveTitle?: string | null;
  objectiveInstruction?: string | null;
  verificationSummary?: string | null;
  followUpNotes?: string | null;
  humanActions: ComposeDeliveryEvidenceItem[];
  tradeoffsMade: ComposeDeliveryEvidenceItem[];
  knownRisks: string[];
  deferredWork: string[];
  assumptions: string[];
  candidateActions: ComposeDeliveryEvidenceItem[];
  changeRationales: Array<{
    id: string;
    filePath: string;
    label: string;
    summary: string;
    why: string;
    impact: string;
  }>;
  recentEvents?: Array<{ type: string; summary: string }>;
};

export type ComposeDeliveryDraft = {
  markdown?: string;
  humanActions?: Array<Record<string, unknown>>;
  tradeoffsMade?: Array<Record<string, unknown>>;
  knownRisks?: string[];
  deferredWork?: string[];
  assumptions?: string[];
  reviewHighlights?: string[];
};

export const COMPOSE_DELIVERY_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    markdown: { type: Type.STRING },
    humanActions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          sourceId: { type: Type.STRING },
          action: { type: Type.STRING },
          reason: { type: Type.STRING },
          category: { type: Type.STRING }
        },
        required: ['sourceId', 'action']
      }
    },
    tradeoffsMade: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          sourceId: { type: Type.STRING },
          decision: { type: Type.STRING },
          rationale: { type: Type.STRING },
          alternativesConsidered: { type: Type.ARRAY, items: { type: Type.STRING } },
          impact: { type: Type.STRING }
        },
        required: ['sourceId', 'decision', 'rationale']
      }
    },
    knownRisks: { type: Type.ARRAY, items: { type: Type.STRING } },
    deferredWork: { type: Type.ARRAY, items: { type: Type.STRING } },
    assumptions: { type: Type.ARRAY, items: { type: Type.STRING } },
    reviewHighlights: { type: Type.ARRAY, items: { type: Type.STRING } }
  },
  required: ['markdown', 'humanActions', 'tradeoffsMade']
};

const SYSTEM_INSTRUCTION = `You compose a polished delivery review message for a coding agent handoff.
Return JSON only matching the schema.
Rules:
- Use the agent summary as the factual spine; improve clarity and organization in markdown.
- Human actions and tradeoffs MUST cite sourceId values from the provided evidence or candidateActions.
- Never invent mandatory human actions or implementation tradeoffs without a sourceId match.
- Never include git commit/push/PR actions or routine "review/test the code" actions.
- Prefer concise, scannable Markdown. Do not include secrets, tokens, or raw diffs.`;

export function buildComposeDeliveryPrompt(input: ComposeDeliveryInput): string {
  return [
    'Compose a delivery presentation from this bounded evidence.',
    '',
    `Agent summary:\n${input.summary}`,
    input.objectiveTitle ? `Objective title: ${input.objectiveTitle}` : null,
    input.objectiveInstruction
      ? `Objective instruction (bounded):\n${input.objectiveInstruction.slice(0, 2000)}`
      : null,
    input.verificationSummary ? `Verification: ${input.verificationSummary}` : null,
    input.followUpNotes ? `Follow-up notes: ${input.followUpNotes}` : null,
    `Human actions evidence:\n${JSON.stringify(input.humanActions)}`,
    `Tradeoffs evidence:\n${JSON.stringify(input.tradeoffsMade)}`,
    `Known risks:\n${JSON.stringify(input.knownRisks)}`,
    `Deferred work:\n${JSON.stringify(input.deferredWork)}`,
    `Assumptions:\n${JSON.stringify(input.assumptions)}`,
    `Deterministic candidate actions:\n${JSON.stringify(input.candidateActions)}`,
    `Change rationales:\n${JSON.stringify(input.changeRationales.slice(0, 20))}`,
    input.recentEvents && input.recentEvents.length > 0
      ? `Recent objective events:\n${JSON.stringify(input.recentEvents.slice(0, 12))}`
      : null
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function composeDeliveryWithGemini(params: {
  input: ComposeDeliveryInput;
  env?: NodeJS.ProcessEnv;
  logPrefix?: string;
  generate?: (args: {
    prompt: string;
    systemInstruction: string;
    responseSchema: Schema;
  }) => Promise<string | null>;
}): Promise<ComposeDeliveryDraft | null> {
  const {
    input,
    env = process.env,
    logPrefix = '[automations/compose-delivery]',
    generate
  } = params;

  const prompt = buildComposeDeliveryPrompt(input);
  const text =
    generate !== undefined
      ? await generate({
          prompt,
          systemInstruction: SYSTEM_INSTRUCTION,
          responseSchema: COMPOSE_DELIVERY_RESPONSE_SCHEMA
        })
      : await generateComposeJson({
          prompt,
          systemInstruction: SYSTEM_INSTRUCTION,
          env,
          logPrefix
        });

  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as ComposeDeliveryDraft;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (error) {
    console.warn(`${logPrefix} failed to parse Gemini JSON:`, error);
    return null;
  }
}

async function generateComposeJson(params: {
  prompt: string;
  systemInstruction: string;
  env: NodeJS.ProcessEnv;
  logPrefix: string;
}): Promise<string | null> {
  const { prompt, systemInstruction, env, logPrefix } = params;
  const client = getGeminiClient(env);
  const config = readGeminiConfigFromEnv(env);
  if (!client || !config) {
    console.warn(`${logPrefix} GEMINI_API_KEY not set`);
    return null;
  }

  try {
    const response = await client.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction,
        temperature: 0.2,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
        responseSchema: COMPOSE_DELIVERY_RESPONSE_SCHEMA
      }
    });
    const text = (response.text ?? '').trim();
    return text || null;
  } catch (error) {
    console.warn(`${logPrefix} Gemini call failed:`, error);
    return null;
  }
}

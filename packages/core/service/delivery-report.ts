import type {
  DeliveryAgentReportInputV1,
  DeliveryAgentReportV1,
  DeliveryReportPayloadV1,
  HumanActionV1,
  TradeoffMadeV1
} from '@overlord/contract';
import { z } from 'zod';

import { ServiceError } from './errors.js';

const MAX_ITEMS = 12;
const MAX_ALTERNATIVES = 6;
const MAX_ACTION_LENGTH = 280;
const MAX_DETAIL_LENGTH = 800;

const humanActionCategorySchema = z.enum([
  'environment',
  'database',
  'deployment',
  'codegen',
  'packaging',
  'external_service',
  'other'
]);

const conciseTextSchema = z.string().trim().min(1).max(MAX_DETAIL_LENGTH);

const humanActionSchema = z.object({
  action: z.string().trim().min(1).max(MAX_ACTION_LENGTH),
  reason: conciseTextSchema.optional(),
  category: humanActionCategorySchema.optional(),
  blocking: z.boolean().optional()
});

const tradeoffSchema = z.object({
  decision: z.string().trim().min(1).max(MAX_ACTION_LENGTH),
  alternativesConsidered: z.array(conciseTextSchema).max(MAX_ALTERNATIVES).optional(),
  rationale: conciseTextSchema,
  impact: conciseTextSchema.optional()
});

const agentReportSchema = z.object({
  humanActions: z.array(humanActionSchema).max(MAX_ITEMS).optional(),
  human_actions: z.array(humanActionSchema).max(MAX_ITEMS).optional(),
  tradeoffsMade: z.array(tradeoffSchema).max(MAX_ITEMS).optional(),
  tradeoffs_made: z.array(tradeoffSchema).max(MAX_ITEMS).optional(),
  knownRisks: z.array(conciseTextSchema).max(MAX_ITEMS).optional(),
  known_risks: z.array(conciseTextSchema).max(MAX_ITEMS).optional(),
  deferredWork: z.array(conciseTextSchema).max(MAX_ITEMS).optional(),
  deferred_work: z.array(conciseTextSchema).max(MAX_ITEMS).optional(),
  assumptions: z.array(conciseTextSchema).max(MAX_ITEMS).optional()
});

const deliveryReportInputSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  agentReport: agentReportSchema.optional(),
  agent_report: agentReportSchema.optional()
});

const GIT_ACTION_PATTERN =
  /\b(?:git\s+(?:commit|push|pull|merge|rebase|checkout|switch|branch)|(?:commit|push|pull|merge|rebase|create|open)\s+(?:a\s+)?(?:branch|pull request|pr))\b/i;
const ROUTINE_QA_PATTERN =
  /\b(?:code review|review (?:the )?code|run (?:the )?tests?|test (?:the )?(?:code|feature)|verify (?:the )?(?:code|feature|implementation|it)(?:\s+(?:works|is working))?|qa)\b/i;

/** Excludes actions agents should complete themselves or that are Git-only workflow. */
export function isDisplayableHumanAction(action: string): boolean {
  return !GIT_ACTION_PATTERN.test(action) && !ROUTINE_QA_PATTERN.test(action);
}

function invalidDeliveryReport(error: z.ZodError): never {
  throw new ServiceError(
    `Invalid deliveryReport: ${z.prettifyError(error)}`,
    'invalid_delivery_report',
    400
  );
}

function normalizeAgentReport(input: DeliveryAgentReportInputV1): DeliveryAgentReportV1 {
  const humanActionInputs = input.humanActions ?? [];
  const tradeoffInputs = input.tradeoffsMade ?? [];
  const humanActions: HumanActionV1[] = humanActionInputs
    .filter(action => isDisplayableHumanAction(action.action))
    .map((action, index) => ({
      id: `human-action-${index + 1}`,
      action: action.action,
      ...(action.reason ? { reason: action.reason } : {}),
      category: action.category ?? 'other',
      ...(action.blocking === undefined ? {} : { blocking: action.blocking }),
      source: 'agent'
    }));
  const tradeoffsMade: TradeoffMadeV1[] = tradeoffInputs.map((tradeoff, index) => ({
    id: `tradeoff-${index + 1}`,
    decision: tradeoff.decision,
    alternativesConsidered: tradeoff.alternativesConsidered ?? [],
    rationale: tradeoff.rationale,
    ...(tradeoff.impact ? { impact: tradeoff.impact } : {}),
    source: 'agent'
  }));

  return {
    humanActions,
    tradeoffsMade,
    knownRisks: input.knownRisks ?? [],
    deferredWork: input.deferredWork ?? [],
    assumptions: input.assumptions ?? []
  };
}

function normalizeWireAgentReport(
  input: z.infer<typeof agentReportSchema>
): DeliveryAgentReportInputV1 {
  return {
    humanActions: input.humanActions ?? input.human_actions ?? [],
    tradeoffsMade: input.tradeoffsMade ?? input.tradeoffs_made ?? [],
    knownRisks: input.knownRisks ?? input.known_risks ?? [],
    deferredWork: input.deferredWork ?? input.deferred_work ?? [],
    assumptions: input.assumptions ?? []
  };
}

/**
 * Builds the contract-v15 fallback synchronously. A later worker may replace only
 * `presentation`; the immutable summary and normalized evidence always remain.
 */
export function buildDeliveryReport({
  summary,
  deliveryReport
}: {
  summary: string;
  deliveryReport: unknown;
}): DeliveryReportPayloadV1 {
  const parsed = deliveryReportInputSchema.safeParse(deliveryReport ?? {});
  if (!parsed.success) invalidDeliveryReport(parsed.error);
  const wireReport = parsed.data.agentReport ?? parsed.data.agent_report ?? {};
  const agentReport = normalizeAgentReport(normalizeWireAgentReport(wireReport));

  return {
    schemaVersion: 1,
    agentReport,
    presentation: {
      status: 'deterministic',
      markdown: summary,
      humanActions: agentReport.humanActions,
      tradeoffsMade: agentReport.tradeoffsMade,
      knownRisks: agentReport.knownRisks,
      deferredWork: agentReport.deferredWork,
      assumptions: agentReport.assumptions,
      generatedBy: 'deterministic'
    }
  };
}

/**
 * Returns a safe read-side delivery report. Persisted V1 reports retain their
 * presentation status (including pending/composed/fallback); legacy or malformed
 * payloads receive the same deterministic projection used by REST readers.
 */
export function readDeliveryReport({
  summary,
  deliveryReport
}: {
  summary: string;
  deliveryReport: unknown;
}): DeliveryReportPayloadV1 {
  if (deliveryReport && typeof deliveryReport === 'object' && !Array.isArray(deliveryReport)) {
    const candidate = deliveryReport as Partial<DeliveryReportPayloadV1>;
    if (
      candidate.schemaVersion === 1 &&
      candidate.agentReport &&
      candidate.presentation &&
      typeof candidate.presentation.markdown === 'string'
    ) {
      return candidate as DeliveryReportPayloadV1;
    }
  }
  return buildDeliveryReport({ summary, deliveryReport: undefined });
}

/** Marks an immediate deterministic report as awaiting async composition. */
export function markDeliveryPresentationPending(
  report: DeliveryReportPayloadV1
): DeliveryReportPayloadV1 {
  return {
    ...report,
    presentation: {
      ...report.presentation,
      status: 'pending'
    }
  };
}

export const DELIVERY_REPORT_LIMITS = {
  maxItems: MAX_ITEMS,
  maxAlternatives: MAX_ALTERNATIVES,
  maxActionLength: MAX_ACTION_LENGTH,
  maxDetailLength: MAX_DETAIL_LENGTH
} as const;

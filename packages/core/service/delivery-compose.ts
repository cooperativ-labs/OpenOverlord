import type {
  DeliveryAgentReportV1,
  DeliveryPresentationV1,
  DeliveryReportPayloadV1,
  HumanActionCategory,
  HumanActionV1,
  TradeoffMadeV1
} from '@overlord/contract';

import { DELIVERY_REPORT_LIMITS, isDisplayableHumanAction } from './delivery-report.js';
import { nowIso } from './util.js';

const HUMAN_ACTION_CATEGORIES = new Set<HumanActionCategory>([
  'environment',
  'database',
  'deployment',
  'codegen',
  'packaging',
  'external_service',
  'other'
]);

/** Bounded draft returned by the compose-delivery automation before reconciliation. */
export type ComposeDeliveryDraft = {
  markdown?: unknown;
  humanActions?: unknown;
  tradeoffsMade?: unknown;
  knownRisks?: unknown;
  deferredWork?: unknown;
  assumptions?: unknown;
  reviewHighlights?: unknown;
};

export type DeterministicActionCandidate = HumanActionV1;

export type ChangeRationaleEvidence = {
  id: string;
  filePath: string;
  label: string;
  summary: string;
  why: string;
  impact: string;
};

/**
 * Derives optional human-action candidates from changed file paths. These are
 * provenance `deterministic_rule` sources Gemini may cite but never invent beyond.
 */
export function deriveDeterministicActionCandidates({
  filePaths
}: {
  filePaths: string[];
}): DeterministicActionCandidate[] {
  const candidates: DeterministicActionCandidate[] = [];
  const seen = new Set<string>();

  const add = ({
    action,
    reason,
    category
  }: {
    action: string;
    reason: string;
    category: HumanActionCategory;
  }) => {
    if (!isDisplayableHumanAction(action) || seen.has(action)) return;
    seen.add(action);
    candidates.push({
      id: `rule-action-${candidates.length + 1}`,
      action,
      reason,
      category,
      source: 'deterministic_rule'
    });
  };

  for (const rawPath of filePaths) {
    const filePath = rawPath.replace(/\\/g, '/');
    const base = filePath.split('/').pop() ?? filePath;
    if (
      /(?:^|\/)(?:migrations?|supabase\/migrations)\//i.test(filePath) ||
      /\.(?:sql)$/i.test(base)
    ) {
      add({
        action: 'Apply the database migration(s) included in this delivery.',
        reason: `Changed path ${filePath} looks like a schema/migration update.`,
        category: 'database'
      });
    }
    if (/(?:^|\/)\.env(?:\.|$)|\.env\.[^/]+$/i.test(filePath) || /env\.example$/i.test(base)) {
      add({
        action: 'Review and set any new environment variables.',
        reason: `Changed path ${filePath} may introduce required configuration.`,
        category: 'environment'
      });
    }
    if (/docker-compose|Dockerfile|fly\.toml|vercel\.json|railway/i.test(filePath)) {
      add({
        action: 'Redeploy the affected service with the updated configuration.',
        reason: `Changed path ${filePath} suggests a deployment/config change.`,
        category: 'deployment'
      });
    }
    if (/package\.json$|Cargo\.toml$|\.csproj$/i.test(base)) {
      add({
        action: 'Reinstall or rebuild package dependencies if your environment is stale.',
        reason: `Changed path ${filePath} may alter dependency resolution.`,
        category: 'packaging'
      });
    }
  }

  return candidates.slice(0, DELIVERY_REPORT_LIMITS.maxItems);
}

function clampText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function clampStringList(
  value: unknown,
  maxItems: number = DELIVERY_REPORT_LIMITS.maxItems
): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = clampText(item, DELIVERY_REPORT_LIMITS.maxDetailLength);
    if (!text) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function asCategory(value: unknown): HumanActionCategory {
  return typeof value === 'string' && HUMAN_ACTION_CATEGORIES.has(value as HumanActionCategory)
    ? (value as HumanActionCategory)
    : 'other';
}

function evidenceActions({
  agentReport,
  candidates
}: {
  agentReport: DeliveryAgentReportV1;
  candidates: DeterministicActionCandidate[];
}): Map<string, HumanActionV1> {
  const byId = new Map<string, HumanActionV1>();
  for (const action of agentReport.humanActions) byId.set(action.id, action);
  for (const action of candidates) byId.set(action.id, action);
  return byId;
}

function evidenceTradeoffs({
  agentReport,
  rationales
}: {
  agentReport: DeliveryAgentReportV1;
  rationales: ChangeRationaleEvidence[];
}): Map<string, TradeoffMadeV1> {
  const byId = new Map<string, TradeoffMadeV1>();
  for (const tradeoff of agentReport.tradeoffsMade) byId.set(tradeoff.id, tradeoff);
  for (const rationale of rationales) {
    byId.set(rationale.id, {
      id: rationale.id,
      decision: rationale.label,
      alternativesConsidered: [],
      rationale: rationale.why,
      impact: rationale.impact,
      source: 'change_rationale',
      sourceRef: rationale.filePath
    });
  }
  return byId;
}

/**
 * Reconciles a model draft against authoritative evidence. Invented actions or
 * tradeoffs without a matching source id are dropped. On null/invalid drafts the
 * deterministic presentation is retained with status `fallback`.
 */
export function reconcileDeliveryComposeDraft({
  report,
  draft,
  candidates = [],
  rationales = [],
  model,
  generatedAt = nowIso()
}: {
  report: DeliveryReportPayloadV1;
  draft: ComposeDeliveryDraft | null;
  candidates?: DeterministicActionCandidate[];
  rationales?: ChangeRationaleEvidence[];
  model?: string | null;
  generatedAt?: string;
}): DeliveryPresentationV1 {
  const fallback: DeliveryPresentationV1 = {
    ...report.presentation,
    status: 'fallback',
    generatedBy: 'deterministic',
    generatedAt,
    ...(model ? { model } : {})
  };

  if (!draft || typeof draft !== 'object') {
    return fallback;
  }

  const markdown = clampText(draft.markdown, 12_000) ?? report.presentation.markdown;

  const actionsById = evidenceActions({
    agentReport: report.agentReport,
    candidates
  });
  const tradeoffsById = evidenceTradeoffs({
    agentReport: report.agentReport,
    rationales
  });

  const humanActions: HumanActionV1[] = [];
  if (Array.isArray(draft.humanActions)) {
    for (const raw of draft.humanActions) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const sourceId = clampText(item.sourceId ?? item.id, 80);
      if (!sourceId) continue;
      const source = actionsById.get(sourceId);
      if (!source) continue;
      const actionText =
        clampText(item.action, DELIVERY_REPORT_LIMITS.maxActionLength) ?? source.action;
      if (!isDisplayableHumanAction(actionText)) continue;
      humanActions.push({
        ...source,
        action: actionText,
        ...(clampText(item.reason, DELIVERY_REPORT_LIMITS.maxDetailLength)
          ? { reason: clampText(item.reason, DELIVERY_REPORT_LIMITS.maxDetailLength)! }
          : source.reason
            ? { reason: source.reason }
            : {}),
        category: asCategory(item.category ?? source.category)
      });
      if (humanActions.length >= DELIVERY_REPORT_LIMITS.maxItems) break;
    }
  }

  const tradeoffsMade: TradeoffMadeV1[] = [];
  if (Array.isArray(draft.tradeoffsMade)) {
    for (const raw of draft.tradeoffsMade) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const sourceId = clampText(item.sourceId ?? item.id, 80);
      if (!sourceId) continue;
      const source = tradeoffsById.get(sourceId);
      if (!source) continue;
      tradeoffsMade.push({
        ...source,
        decision:
          clampText(item.decision, DELIVERY_REPORT_LIMITS.maxActionLength) ?? source.decision,
        rationale:
          clampText(item.rationale, DELIVERY_REPORT_LIMITS.maxDetailLength) ?? source.rationale,
        alternativesConsidered:
          clampStringList(item.alternativesConsidered, DELIVERY_REPORT_LIMITS.maxAlternatives)
            .length > 0
            ? clampStringList(item.alternativesConsidered, DELIVERY_REPORT_LIMITS.maxAlternatives)
            : source.alternativesConsidered,
        ...(clampText(item.impact, DELIVERY_REPORT_LIMITS.maxDetailLength)
          ? { impact: clampText(item.impact, DELIVERY_REPORT_LIMITS.maxDetailLength)! }
          : source.impact
            ? { impact: source.impact }
            : {})
      });
      if (tradeoffsMade.length >= DELIVERY_REPORT_LIMITS.maxItems) break;
    }
  }

  // If the model returned nothing usable for structured sections, keep evidence.
  const resolvedActions = humanActions.length > 0 ? humanActions : report.presentation.humanActions;
  const resolvedTradeoffs =
    tradeoffsMade.length > 0 ? tradeoffsMade : report.presentation.tradeoffsMade;

  return {
    status: 'composed',
    markdown: markdown || report.presentation.markdown,
    humanActions: resolvedActions,
    tradeoffsMade: resolvedTradeoffs,
    knownRisks:
      clampStringList(draft.knownRisks).length > 0
        ? clampStringList(draft.knownRisks)
        : report.presentation.knownRisks,
    deferredWork:
      clampStringList(draft.deferredWork).length > 0
        ? clampStringList(draft.deferredWork)
        : report.presentation.deferredWork,
    assumptions:
      clampStringList(draft.assumptions).length > 0
        ? clampStringList(draft.assumptions)
        : report.presentation.assumptions,
    generatedBy: 'gemini',
    generatedAt,
    ...(model ? { model } : {})
  };
}

/** Applies a composed/fallback presentation onto the versioned delivery report. */
export function applyDeliveryPresentation({
  report,
  presentation
}: {
  report: DeliveryReportPayloadV1;
  presentation: DeliveryPresentationV1;
}): DeliveryReportPayloadV1 {
  return {
    schemaVersion: 1,
    agentReport: report.agentReport,
    presentation
  };
}

import {
  Activity,
  AlertCircle,
  ArrowRightLeft,
  CheckCircle2,
  FileText,
  HelpCircle,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  Package,
  Rocket,
  Scale,
  ShieldQuestion
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion';
import { AuthenticatedAvatarImage, Avatar, AvatarFallback } from '@/components/ui/avatar';

import type { DeliveryDto, MissionEventDto, MissionEventType } from '../../shared/contract.ts';
import { useMissionDeliveries, useMissionEvents } from '../lib/queries.ts';

import { Markdown } from './Markdown.tsx';
import { Badge, Spinner } from './ui.tsx';

/**
 * Icon + human label for each `mission_events.type` value. Unknown (future)
 * types fall back to a neutral dot and the raw type string so the feed never
 * breaks when the server vocabulary grows ahead of the client.
 */
const EVENT_META: Record<MissionEventType, { icon: LucideIcon; label: string }> = {
  update: { icon: Activity, label: 'Update' },
  user_follow_up: { icon: MessageSquare, label: 'Follow-up' },
  alert: { icon: AlertCircle, label: 'Alert' },
  discussion_summary: { icon: FileText, label: 'Discussion' },
  decision: { icon: CheckCircle2, label: 'Decision' },
  ask: { icon: HelpCircle, label: 'Question' },
  permission_request: { icon: ShieldQuestion, label: 'Permission' },
  delivery: { icon: Package, label: 'Delivered' },
  execution_requested: { icon: Rocket, label: 'Launch requested' },
  awaiting_approval: { icon: HelpCircle, label: 'Awaiting approval' },
  status_change: { icon: ArrowRightLeft, label: 'Status changed' }
};

function eventMeta(type: string): { icon: LucideIcon | null; label: string } {
  return EVENT_META[type as MissionEventType] ?? { icon: null, label: type.replace(/_/g, ' ') };
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Scaled deliver card: width accounts for 110% scale; callers add left/right escape margins. */
const DELIVERY_CARD_EMPHASIS_CLASS =
  'relative z-10 w-[calc((100%-1rem)/1.1)] max-w-[calc((100%-1rem)/1.1)] origin-top-left scale-110 rounded-lg bg-white shadow-md dark:bg-black';

function actorLabel(event: MissionEventDto): string {
  return event.actor?.displayName?.trim() || event.actor?.handle || 'User';
}

function actorInitials(label: string): string {
  return (
    label
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0])
      .join('')
      .toUpperCase() || 'U'
  );
}

/**
 * Renders an event summary. By default the text is shown clamped and *plain*
 * (no markdown formatting) so the feed stays clean and visually consistent
 * regardless of how each summary was authored. Clicking the summary lifts it
 * into a "detail" card — white/black background, `rounded-sm`, `shadow-md` —
 * where the markdown in the text is actually rendered with formatting.
 * Clicking anywhere outside the card returns it to the default plain state.
 */
function ExpandableSummary({ text, tone }: { text: string; tone: string }) {
  const measureRef = useRef<HTMLParagraphElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [isClamped, setIsClamped] = useState(false);

  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el || expanded) return;
    // Compare full content height against the collapsed (clamped) height to
    // decide whether the summary is long enough to warrant an expand hint.
    setIsClamped(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  // Collapse back to the default state when the user clicks/taps outside the
  // expanded detail card, or presses Escape.
  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded]);

  if (expanded) {
    return (
      <div
        ref={cardRef}
        role="button"
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(false);
          }
        }}
        className="cursor-pointer rounded-sm bg-white p-3 shadow-md dark:bg-black"
      >
        <Markdown text={text} />
      </div>
    );
  }

  // `isClamped` is retained purely to drive the subtle "Show more" affordance
  // below; the whole summary is clickable regardless so any event can be
  // lifted into its formatted detail card.
  return (
    <div className="grid gap-0.5">
      <p
        ref={measureRef}
        onClick={() => setExpanded(true)}
        role="button"
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(true);
          }
        }}
        className={`line-clamp-4 cursor-pointer whitespace-pre-wrap wrap-anywhere text-sm ${tone}`}
      >
        {text}
      </p>
      {isClamped && (
        <span className="justify-self-start text-[11px] font-medium text-sky-600 dark:text-sky-400">
          Show more
        </span>
      )}
    </div>
  );
}

function DeliveryDetails({
  missionId,
  deliveryId,
  summaryText
}: {
  missionId: string;
  deliveryId: string;
  summaryText: string;
}) {
  const deliveriesQ = useMissionDeliveries(missionId, true);
  const delivery = deliveriesQ.data?.find(candidate => candidate.id === deliveryId);

  if (deliveriesQ.isLoading) {
    return (
      <div className={`${DELIVERY_CARD_EMPHASIS_CLASS} p-3`}>
        <Spinner />
      </div>
    );
  }
  if (deliveriesQ.isError || !delivery) {
    return (
      <p className={`${DELIVERY_CARD_EMPHASIS_CLASS} p-3 text-sm text-(--color-ink-dim)`}>
        Could not load delivery details.
      </p>
    );
  }

  return <DeliveryPresentation delivery={delivery} summaryText={summaryText} />;
}

function DeliveryPresentation({
  delivery,
  summaryText
}: {
  delivery: DeliveryDto;
  summaryText: string;
}) {
  const presentation = delivery.report.presentation;
  return (
    <div className={`${DELIVERY_CARD_EMPHASIS_CLASS} grid gap-3 p-3`}>
      {presentation.status === 'pending' ? (
        <p className="text-xs text-(--color-ink-dim)" role="status">
          Adding delivery details…
        </p>
      ) : null}
      <Markdown text={presentation.markdown} />
      {presentation.humanActions.length > 0 ? (
        <section
          aria-labelledby={`delivery-actions-${delivery.id}`}
          className="rounded-md border border-sky-300 bg-sky-50 p-3 dark:border-sky-500/50 dark:bg-sky-500/10"
        >
          <h4
            id={`delivery-actions-${delivery.id}`}
            className="flex items-center gap-1.5 text-sm font-semibold text-sky-950 dark:text-sky-100"
          >
            <ListChecks className="size-4" aria-hidden="true" />
            Follow-up actions
          </h4>
          <ul className="mt-2 grid gap-2 text-sm text-sky-950 dark:text-sky-100">
            {presentation.humanActions.map(action => (
              <li key={action.id}>
                <span className="font-medium">{action.action}</span>
                {action.reason ? (
                  <span className="block text-sky-800 dark:text-sky-200">{action.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {presentation.tradeoffsMade.length > 0 ? (
        <section
          aria-labelledby={`delivery-tradeoffs-${delivery.id}`}
          className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/50 dark:bg-amber-500/10"
        >
          <h4
            id={`delivery-tradeoffs-${delivery.id}`}
            className="flex items-center gap-1.5 text-sm font-semibold text-amber-950 dark:text-amber-100"
          >
            <Scale className="size-4" aria-hidden="true" />
            Tradeoffs made
          </h4>
          <ul className="mt-2 grid gap-3 text-sm text-amber-950 dark:text-amber-100">
            {presentation.tradeoffsMade.map(tradeoff => (
              <li key={tradeoff.id}>
                <span className="font-medium">{tradeoff.decision}</span>
                <span className="block text-amber-800 dark:text-amber-200">
                  {tradeoff.rationale}
                </span>
                {tradeoff.alternativesConsidered.length > 0 ? (
                  <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">
                    Considered: {tradeoff.alternativesConsidered.join(', ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Accordion className="border-t border-(--color-ink-dim)/15 pt-1">
        <AccordionItem value="summary" className="border-none">
          <AccordionTrigger className="py-2 text-xs font-medium text-(--color-ink-dim) hover:no-underline">
            Delivery summary
          </AccordionTrigger>
          <AccordionContent>
            <p className="whitespace-pre-wrap text-sm text-(--color-ink-dim)">{summaryText}</p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

/**
 * Delivery events show a plain summary line by default. Clicking it swaps in the
 * AI-generated deliver card in place of that text; the summary moves into an
 * accordion at the bottom of the card. Click outside or press Escape to collapse.
 */
function DeliveryExpandable({
  missionId,
  deliveryId,
  summary
}: {
  missionId: string;
  deliveryId: string;
  summary: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cursor-pointer text-left text-sm text-(--color-ink-dim) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
      >
        {summary}
      </button>
    );
  }

  return (
    <div ref={cardRef} className="-ml-4 overflow-visible">
      <DeliveryDetails missionId={missionId} deliveryId={deliveryId} summaryText={summary} />
    </div>
  );
}

function ActivityEntry({ event, missionId }: { event: MissionEventDto; missionId: string }) {
  const { icon: Icon, label } = eventMeta(event.type);
  const isUserFollowUp = event.type === 'user_follow_up';
  // Blocking questions posted via `ovld protocol ask` land as `ask` events. Give
  // them a subtle amber/orange outline + wash so they stand out as needing a reply.
  const isBlockingQuestion = event.type === 'ask';
  const isDelivery = event.type === 'delivery' && Boolean(event.deliveryId);
  const userLabel = actorLabel(event);

  return (
    <article
      className={
        isBlockingQuestion
          ? 'flex min-w-0 gap-3 rounded-md border border-amber-400/50 bg-amber-50/60 px-3 py-2 dark:border-amber-500/40 dark:bg-amber-500/10'
          : 'flex min-w-0 gap-3'
      }
    >
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center">
        {isUserFollowUp && event.actor ? (
          <Avatar size="sm" title={userLabel}>
            {event.actor.avatarUrl ? (
              <AuthenticatedAvatarImage src={event.actor.avatarUrl} alt={userLabel} />
            ) : null}
            <AvatarFallback className="rounded-full text-[9px]">
              {actorInitials(userLabel)}
            </AvatarFallback>
          </Avatar>
        ) : Icon ? (
          <Icon
            className={
              isUserFollowUp
                ? 'h-3.5 w-3.5 text-sky-500'
                : isBlockingQuestion
                  ? 'h-3.5 w-3.5 text-amber-600 dark:text-amber-400'
                  : 'h-3.5 w-3.5 text-(--color-ink-dim)'
            }
          />
        ) : (
          <div className="h-2 w-2 rounded-full bg-(--color-ink-dim)/40" />
        )}
      </div>
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              isUserFollowUp
                ? 'text-xs font-medium text-sky-600 dark:text-sky-400'
                : isBlockingQuestion
                  ? 'text-xs font-medium text-amber-700 dark:text-amber-300'
                  : 'text-xs font-medium text-(--color-ink)'
            }
          >
            {isUserFollowUp && event.actor ? userLabel : label}
          </span>
          {isUserFollowUp && event.actor ? (
            <span className="text-[11px] text-(--color-ink-dim)">Follow-up</span>
          ) : null}
          {event.phase && (
            <Badge className="px-2 py-0 text-[10px] uppercase tracking-wide">{event.phase}</Badge>
          )}
          <span className="text-[11px] text-(--color-ink-dim)">
            {formatTimestamp(event.createdAt)}
          </span>
        </div>
        {event.summary ? (
          isDelivery && event.deliveryId ? (
            <DeliveryExpandable
              missionId={missionId}
              deliveryId={event.deliveryId}
              summary={event.summary}
            />
          ) : (
            <ExpandableSummary
              text={event.summary}
              tone={isUserFollowUp ? 'text-sky-700 dark:text-sky-300' : 'text-(--color-ink-dim)'}
            />
          )
        ) : (
          <p className="text-sm italic text-(--color-ink-dim)">No summary.</p>
        )}
        {event.externalUrl && (
          <a
            href={event.externalUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-sky-600 underline-offset-2 hover:underline dark:text-sky-400"
          >
            View details
          </a>
        )}
      </div>
    </article>
  );
}

/**
 * Realtime feed of a mission's workflow history (`mission_events`). The query is
 * invalidated by the global SSE change feed, so updates written by the agent or
 * CLI in another process stream into the panel without a manual refresh.
 */
export function LiveActivityFeed({ missionId }: { missionId: string }) {
  const eventsQ = useMissionEvents(missionId);

  if (eventsQ.isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner />
      </div>
    );
  }

  if (eventsQ.isError) {
    return (
      <p className="text-sm text-red-400">
        Could not load activity: {(eventsQ.error as Error)?.message ?? 'unknown error'}
      </p>
    );
  }

  const events = eventsQ.data ?? [];
  if (events.length === 0) {
    return <p className="text-sm italic text-(--color-ink-dim)">No activity yet.</p>;
  }

  return (
    <div className="grid min-w-0 gap-3">
      {events.map(event => (
        <ActivityEntry key={event.id} event={event} missionId={missionId} />
      ))}
    </div>
  );
}

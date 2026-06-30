import {
  Activity,
  AlertCircle,
  ArrowRightLeft,
  CheckCircle2,
  FileText,
  HelpCircle,
  type LucideIcon,
  MessageSquare,
  Package,
  Rocket,
  ShieldQuestion
} from 'lucide-react';

import { Avatar, AvatarFallback, AuthenticatedAvatarImage } from '@/components/ui/avatar';

import type { MissionEventDto, MissionEventType } from '../../shared/contract.ts';
import { useMissionEvents } from '../lib/queries.ts';

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

function ActivityEntry({ event }: { event: MissionEventDto }) {
  const { icon: Icon, label } = eventMeta(event.type);
  const isUserFollowUp = event.type === 'user_follow_up';
  const userLabel = actorLabel(event);

  return (
    <article className="flex min-w-0 gap-3">
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
              isUserFollowUp ? 'h-3.5 w-3.5 text-sky-500' : 'h-3.5 w-3.5 text-(--color-ink-dim)'
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
          <p
            className={
              isUserFollowUp
                ? 'whitespace-pre-wrap wrap-anywhere text-sm text-sky-700 dark:text-sky-300'
                : 'whitespace-pre-wrap wrap-anywhere text-sm text-(--color-ink-dim)'
            }
          >
            {event.summary}
          </p>
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
        <ActivityEntry key={event.id} event={event} />
      ))}
    </div>
  );
}

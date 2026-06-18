import type { EntityChangeDto, ObjectiveDto, TicketEventDto } from '../../shared/contract.ts';

import { api } from './api.ts';
import { isNativeNotificationsEnabled } from './native-notification-preferences.ts';

type NotificationPayload = {
  title: string;
  body: string;
  tag: string;
};

const notifiedKeys = new Set<string>();
let browserPermissionRequest: Promise<NotificationPermission> | null = null;

function remember(key: string): boolean {
  if (notifiedKeys.has(key)) return false;
  notifiedKeys.add(key);
  return true;
}

function objectiveLabel(objective: ObjectiveDto | undefined, index: number): string {
  return objective?.title?.trim() || `Objective ${index + 1}`;
}

function eventIsRecent(event: TicketEventDto, sinceMs: number): boolean {
  const createdAt = Date.parse(event.createdAt);
  if (!Number.isFinite(createdAt)) return false;
  return createdAt >= sinceMs - 5_000;
}

async function showBrowserNotification(payload: NotificationPayload): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;

  let permission = Notification.permission;
  if (permission === 'default') {
    browserPermissionRequest ??= Notification.requestPermission();
    permission = await browserPermissionRequest;
  }
  if (permission !== 'granted') return false;

  new Notification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    silent: false
  });
  return true;
}

async function showNativeNotification(payload: NotificationPayload): Promise<void> {
  if (!isNativeNotificationsEnabled()) return;

  const desktopNotifier = window.overlord?.showNotification;
  if (desktopNotifier) {
    const shown = await desktopNotifier(payload);
    if (shown) return;
  }
  await showBrowserNotification(payload);
}

function earliestChangeTime(changes: EntityChangeDto[]): number {
  const times = changes
    .map(change => Date.parse(change.occurredAt))
    .filter(time => Number.isFinite(time));
  return times.length > 0 ? Math.min(...times) : Date.now();
}

export async function notifyWorkflowChanges(changes: EntityChangeDto[]): Promise<void> {
  const ticketIds = [
    ...new Set(changes.map(change => change.ticketId).filter(Boolean))
  ] as string[];
  if (ticketIds.length === 0) return;

  const sinceMs = earliestChangeTime(changes);

  for (const ticketId of ticketIds) {
    const ticketChanges = changes.filter(change => change.ticketId === ticketId);
    const affectedObjectiveIds = new Set(
      ticketChanges
        .filter(change => change.entityType === 'objective')
        .map(change => change.objectiveId)
        .filter(Boolean) as string[]
    );

    const [ticket, events] = await Promise.all([
      api.getTicket(ticketId),
      api.listTicketEvents(ticketId)
    ]);

    for (const objective of ticket.objectives) {
      if (!affectedObjectiveIds.has(objective.id) || objective.state !== 'executing') continue;
      const key = `objective-executing:${objective.id}:${objective.updatedAt}`;
      if (!remember(key)) continue;
      const index = ticket.objectives.findIndex(item => item.id === objective.id);
      await showNativeNotification({
        title: 'Agent started',
        body: `${ticket.displayId}: ${objectiveLabel(objective, index)}`,
        tag: key
      });
    }

    for (const event of events) {
      if (!eventIsRecent(event, sinceMs)) continue;
      if (event.type === 'ask') {
        const key = `blocking-question:${event.id}`;
        if (!remember(key)) continue;
        await showNativeNotification({
          title: 'Blocking question',
          body: `${ticket.displayId}: ${event.summary}`,
          tag: key
        });
      }
      if (event.type === 'delivery') {
        const key = `objective-delivered:${event.id}`;
        if (!remember(key)) continue;
        await showNativeNotification({
          title: 'Ready for review',
          body: `${ticket.displayId}: ${event.summary}`,
          tag: key
        });
      }
    }
  }
}

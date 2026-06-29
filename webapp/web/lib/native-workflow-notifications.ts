import type { EntityChangeDto, MissionEventDto, ObjectiveDto } from '../../shared/contract.ts';

import { api } from './api.ts';
import { isNativeNotificationsEnabled } from './native-notification-preferences.ts';

type WorkflowNotificationKind =
  | 'agent_started'
  | 'ready_for_review'
  | 'blocking_question'
  | 'launch_failed';

type NotificationPayload = {
  title: string;
  body: string;
  tag: string;
};

export type WorkflowNotificationCandidate = {
  kind: WorkflowNotificationKind;
  missionId: string;
  objectiveId: string | null;
  entityId: string;
  seq: number;
  occurredAt: string;
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

function eventIsRecent(event: MissionEventDto, sinceMs: number): boolean {
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
  if (typeof window === 'undefined') return;

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

function hasChangedField(change: EntityChangeDto, field: string): boolean {
  return change.changedFields.includes(field);
}

function candidateKey(candidate: WorkflowNotificationCandidate): string {
  return [
    candidate.kind,
    candidate.missionId,
    candidate.objectiveId ?? '',
    candidate.entityId,
    candidate.seq
  ].join(':');
}

function dedupeCandidates(
  candidates: WorkflowNotificationCandidate[]
): WorkflowNotificationCandidate[] {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = candidateKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function selectWorkflowNotificationCandidates(
  changes: EntityChangeDto[]
): WorkflowNotificationCandidate[] {
  const candidates: WorkflowNotificationCandidate[] = [];

  for (const change of changes) {
    if (!change.missionId) continue;

    if (
      change.entityType === 'objective' &&
      change.operation === 'update' &&
      change.objectiveId &&
      hasChangedField(change, 'state')
    ) {
      candidates.push({
        kind: 'agent_started',
        missionId: change.missionId,
        objectiveId: change.objectiveId,
        entityId: change.entityId,
        seq: change.seq,
        occurredAt: change.occurredAt
      });
      if (hasChangedField(change, 'completed_at')) {
        candidates.push({
          kind: 'ready_for_review',
          missionId: change.missionId,
          objectiveId: change.objectiveId,
          entityId: change.entityId,
          seq: change.seq,
          occurredAt: change.occurredAt
        });
      }
      continue;
    }

    if (change.entityType === 'mission_event' && change.operation === 'insert') {
      candidates.push({
        kind: 'blocking_question',
        missionId: change.missionId,
        objectiveId: change.objectiveId,
        entityId: change.entityId,
        seq: change.seq,
        occurredAt: change.occurredAt
      });
      candidates.push({
        kind: 'ready_for_review',
        missionId: change.missionId,
        objectiveId: change.objectiveId,
        entityId: change.entityId,
        seq: change.seq,
        occurredAt: change.occurredAt
      });
      continue;
    }

    if (
      change.entityType === 'execution_request' &&
      change.operation === 'update' &&
      change.objectiveId &&
      hasChangedField(change, 'status') &&
      hasChangedField(change, 'last_error')
    ) {
      candidates.push({
        kind: 'launch_failed',
        missionId: change.missionId,
        objectiveId: change.objectiveId,
        entityId: change.entityId,
        seq: change.seq,
        occurredAt: change.occurredAt
      });
    }
  }

  return dedupeCandidates(candidates);
}

function eventMatchesCandidate(
  event: MissionEventDto,
  candidate: WorkflowNotificationCandidate,
  sinceMs: number
): boolean {
  if (candidate.kind === 'blocking_question') {
    return event.id === candidate.entityId && event.type === 'ask';
  }
  if (candidate.kind === 'ready_for_review') {
    return event.id === candidate.entityId && event.type === 'delivery';
  }
  if (candidate.kind === 'launch_failed') {
    return (
      event.objectiveId === candidate.objectiveId &&
      event.type === 'status_change' &&
      event.summary.startsWith('Agent run failed:') &&
      eventIsRecent(event, sinceMs)
    );
  }
  return false;
}

export async function notifyWorkflowChanges(changes: EntityChangeDto[]): Promise<void> {
  const candidates = selectWorkflowNotificationCandidates(changes);
  if (candidates.length === 0) return;
  const sinceMs = earliestChangeTime(changes);
  const candidatesByMission = new Map<string, WorkflowNotificationCandidate[]>();
  for (const candidate of candidates) {
    const missionCandidates = candidatesByMission.get(candidate.missionId) ?? [];
    missionCandidates.push(candidate);
    candidatesByMission.set(candidate.missionId, missionCandidates);
  }

  for (const [missionId, missionCandidates] of candidatesByMission) {
    const [mission, events] = await Promise.all([
      api.getMission(missionId),
      api.listMissionEvents(missionId)
    ]);

    for (const candidate of missionCandidates) {
      if (candidate.kind === 'agent_started') {
        const objective = mission.objectives.find(item => item.id === candidate.objectiveId);
        if (objective?.state !== 'executing') continue;
        const key = `objective-executing:${objective.id}:r${objective.revision}`;
        if (!remember(key)) continue;
        const index = mission.objectives.findIndex(item => item.id === objective.id);
        await showNativeNotification({
          title: 'Agent started',
          body: `${mission.displayId}: ${objectiveLabel(objective, index)}`,
          tag: key
        });
        continue;
      }

      const event = events.find(item => eventMatchesCandidate(item, candidate, sinceMs));
      if (!event) {
        if (candidate.kind === 'ready_for_review') {
          const objective = mission.objectives.find(item => item.id === candidate.objectiveId);
          if (objective?.state !== 'complete') continue;
          const key = `objective-complete:${objective.id}:r${objective.revision}`;
          if (!remember(key)) continue;
          const index = mission.objectives.findIndex(item => item.id === objective.id);
          await showNativeNotification({
            title: 'Ready for review',
            body: `${mission.displayId}: ${objectiveLabel(objective, index)}`,
            tag: key
          });
          continue;
        }

        if (candidate.kind === 'launch_failed') {
          const key = `launch-failed:${candidate.entityId}:seq:${candidate.seq}`;
          if (!remember(key)) continue;
          await showNativeNotification({
            title: 'Launch failed',
            body: `${mission.displayId}: Agent run failed`,
            tag: key
          });
        }
        continue;
      }

      if (candidate.kind === 'blocking_question') {
        const key = `blocking-question:${event.id}`;
        if (!remember(key)) continue;
        await showNativeNotification({
          title: 'Blocking question',
          body: `${mission.displayId}: ${event.summary}`,
          tag: key
        });
      }

      if (candidate.kind === 'ready_for_review') {
        const key = `objective-delivered:${event.id}`;
        if (!remember(key)) continue;
        await showNativeNotification({
          title: 'Ready for review',
          body: `${mission.displayId}: ${event.summary}`,
          tag: key
        });
      }

      if (candidate.kind === 'launch_failed') {
        const key = `launch-failed:${event.id}`;
        if (!remember(key)) continue;
        await showNativeNotification({
          title: 'Launch failed',
          body: `${mission.displayId}: ${event.summary}`,
          tag: key
        });
      }
    }
  }
}

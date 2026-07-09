// ---- Everhour extension contract -----------------------------------------
//
// Time tracking via Everhour (https://api.everhour.com). Extension endpoints are
// exposed under `/ext/everhour/`; the workspace API key is stored server-side and
// never returned to clients.

/** Connection state for the workspace Everhour integration (never includes the key). */
export interface EverhourIntegrationDto {
  /** True when a workspace Everhour API key is configured. */
  connected: boolean;
  /** Name of the authenticated Everhour user, when the key validated. */
  accountName: string | null;
}

/** Body for `PUT /ext/everhour/integration` - sets/replaces the workspace API key. */
export interface UpdateEverhourIntegrationBody {
  apiKey: string;
}

/** Everhour project link state for one Overlord project. */
export interface ProjectEverhourLinkDto {
  projectId: string;
  everhourProjectName: string | null;
  everhourProjectId: string | null;
}

/**
 * Body for `PUT /ext/everhour/projects/:projectId/link` - links the Overlord
 * project to an Everhour project by name. A non-empty name finds-or-creates the
 * matching Everhour project and stores its id + name; `null`/empty unlinks.
 */
export interface LinkProjectEverhourBody {
  everhourProjectName: string | null;
}

/** A single Everhour time record for a task, normalized for the mission panel. */
export interface EverhourTimeRecordDto {
  /** Everhour time-record id (numeric in Everhour; carried as a string here). */
  id: string;
  /** Recorded duration in seconds. */
  timeSeconds: number;
  /** Record date, `YYYY-MM-DD`. */
  date: string;
  /** Free-text comment, when present. */
  comment: string | null;
}

/** The currently running Everhour timer, when one is active for the API key's user. */
export interface EverhourTimerDto {
  /** Everhour task id the timer is running against. */
  taskId: string;
  /** ISO-ish start time reported by Everhour (`YYYY-MM-DD HH:MM:SS`), when present. */
  startedAt: string | null;
  /** Seconds elapsed as last reported by Everhour. */
  durationSeconds: number;
  /** Timer comment, when present. */
  comment: string | null;
}

/**
 * Everhour state for one mission: whether the workspace is connected, the linked
 * task, the task's time records, and whether this mission's timer is running.
 */
export interface MissionEverhourStateDto {
  /** True when a workspace Everhour API key is configured. */
  connected: boolean;
  /** True when the mission's project has a linked Everhour project. */
  projectLinked: boolean;
  /** Everhour task id linked to this mission, or `null` if not linked yet. */
  taskId: string | null;
  /** Time records for the linked task (empty when not linked). */
  records: EverhourTimeRecordDto[];
  /** Total recorded time across `records`, in seconds. */
  totalSeconds: number;
  /** The running timer when it belongs to this mission's task, else `null`. */
  runningTimer: EverhourTimerDto | null;
}

/**
 * Everhour state for one Overlord project's fixed `general` task: connection,
 * project link, time records, and whether the project timer is running.
 */
export interface ProjectEverhourStateDto {
  /** True when a workspace Everhour API key is configured. */
  connected: boolean;
  /** True when this project has a linked Everhour project. */
  projectLinked: boolean;
  /** Everhour task id for the project's `general` task, or `null` if not created yet. */
  taskId: string | null;
  /** Time records for the `general` task (empty when not linked). */
  records: EverhourTimeRecordDto[];
  /** Total recorded time across `records`, in seconds. */
  totalSeconds: number;
  /** The running timer when it belongs to this project's `general` task, else `null`. */
  runningTimer: EverhourTimerDto | null;
}

/** Body for `POST /ext/everhour/missions/:missionId/time` - add manual time. */
export interface CreateEverhourTimeBody {
  /** Duration in seconds (must be > 0). */
  timeSeconds: number;
  /** Record date, `YYYY-MM-DD`. Defaults to today (server timezone) when omitted. */
  date?: string;
  comment?: string | null;
}

/** Body for `PATCH /ext/everhour/missions/:missionId/time/:recordId` - edit time. */
export interface UpdateEverhourTimeBody {
  /** New duration in seconds (must be > 0). */
  timeSeconds: number;
  comment?: string | null;
}

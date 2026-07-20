/**
 * Launch variable library — the built-in `{VAR_NAME}` placeholders Overlord
 * resolves when substituting project launch-preparation settings
 * (`preLaunchCommands` and `launchEnvVars` values).
 *
 * The substitution set is intentionally open-ended: unknown placeholders are
 * left verbatim at launch time, and this catalog documents the built-ins the
 * product surfaces in the Project Settings UI. It is not a closed vocabulary.
 *
 * Interpolation syntax: `{VAR_NAME}` (upper snake-case). User-defined launch
 * env vars are referenced from shell with `$NAME` after they are exported —
 * `{VAR}` always means Overlord launch context, never another user-defined var.
 */

/**
 * When a variable's value exists in the launch sequence.
 *
 * - `plan_build` — resolved during `buildLaunchPlan`, so `{VAR}` placeholders in
 *   `launchEnvVars` values and `preLaunchCommands` can substitute it.
 * - `terminal_env` — exported into the agent process environment (always true for
 *   plan_build vars; listed explicitly when the var is primarily an env export).
 * - `attach` — present only after `ovld protocol attach` (or MCP attach). NOT
 *   available for `{VAR}` substitution during launch preparation.
 */
export type LaunchVariableAvailability = 'plan_build' | 'terminal_env' | 'attach';

export type LaunchVariableDefinition = {
  /** Placeholder name without braces — e.g. `MISSION_ID`. */
  name: string;
  /** Short reviewer/user-facing description. */
  description: string;
  /** Example resolved value for the settings UI. */
  example: string;
  /**
   * Stages at which this value exists. A variable usable in `{VAR}` placeholders
   * must include `plan_build`.
   */
  availableAt: LaunchVariableAvailability[];
  /** Optional format note (JSON, space-separated paths, etc.). */
  format?: string;
};

/**
 * Built-in launch variables, ordered for the Project Settings library UI.
 * Keep in sync with `buildPreLaunchVariables` in `cli/src/pre-launch.ts`.
 */
export const LAUNCH_VARIABLES: readonly LaunchVariableDefinition[] = [
  {
    name: 'MISSION_ID',
    description: 'Mission display id for the launch (e.g. coo:359).',
    example: 'coo:359',
    availableAt: ['plan_build', 'terminal_env']
  },
  {
    name: 'OVERLORD_MISSION_ID',
    description: 'Same value as MISSION_ID — preferred Overlord-prefixed form.',
    example: 'coo:359',
    availableAt: ['plan_build', 'terminal_env']
  },
  {
    name: 'OVERLORD_BACKEND_URL',
    description: 'Backend URL the agent CLI/MCP should call for this launch.',
    example: 'http://127.0.0.1:4310',
    availableAt: ['plan_build', 'terminal_env']
  },
  {
    name: 'OVERLORD_EXECUTION_REQUEST_ID',
    description:
      'Execution-request id when the launch is runner-driven. Empty/absent for a bare `ovld launch`.',
    example: '380e8a6a-ccf0-49f4-9761-f1c0ba02c39c',
    availableAt: ['plan_build', 'terminal_env']
  },
  {
    name: 'OVERLORD_WORKING_DIRECTORY',
    description:
      'Absolute path the agent terminal cds into — the resolved execution-target checkout (or worktree).',
    example: '/Users/you/src/overlord',
    availableAt: ['plan_build', 'terminal_env']
  },
  {
    name: 'OVERLORD_CONTEXT_FILE',
    description:
      'Absolute path to the markdown briefing written for this launch under `.overlord/tmp/`.',
    example: '/Users/you/src/overlord/.overlord/tmp/mission-coo-359.md',
    availableAt: ['plan_build', 'terminal_env']
  },
  {
    name: 'OVERLORD_TMPDIR',
    description:
      'Project-scoped scratch directory (`.overlord/tmp/`). Also mirrored as TMPDIR/TMP/TEMP.',
    example: '/Users/you/src/overlord/.overlord/tmp',
    availableAt: ['plan_build', 'terminal_env']
  },
  {
    name: 'TMPDIR',
    description: 'Same path as OVERLORD_TMPDIR — standard temp-dir env name.',
    example: '/Users/you/src/overlord/.overlord/tmp',
    availableAt: ['plan_build', 'terminal_env']
  },
  {
    name: 'TMP',
    description: 'Same path as OVERLORD_TMPDIR — Windows-style temp-dir alias.',
    example: '/Users/you/src/overlord/.overlord/tmp',
    availableAt: ['plan_build', 'terminal_env']
  },
  {
    name: 'TEMP',
    description: 'Same path as OVERLORD_TMPDIR — Windows-style temp-dir alias.',
    example: '/Users/you/src/overlord/.overlord/tmp',
    availableAt: ['plan_build', 'terminal_env']
  },
  {
    name: 'OVERLORD_PROJECT_RESOURCES',
    description:
      'JSON array of every project resource for this execution target (resourceKey, path, state, flags, accessMode). Set only when the project has resources.',
    example:
      '[{"resourceKey":"primary","path":"/repo/a","state":"ready","isPrimary":true,"accessMode":"read_write"}]',
    availableAt: ['plan_build', 'terminal_env'],
    format: 'JSON array'
  },
  {
    name: 'OVERLORD_PROJECT_RESOURCES_PATHS',
    description:
      'Comma-separated absolute paths of connected project resources with explicit `:rw` or `:ro` permission suffixes (entries without a local path are omitted). `read_write` resources emit `:rw`; reference (`read`) resources emit `:ro`.',
    example: '/repo/a:rw,/repo/b:ro',
    availableAt: ['plan_build', 'terminal_env'],
    format: 'comma-separated paths with :rw/:ro suffix'
  },
  {
    name: 'OVERLORD_PROJECT_RESOURCES_PATHS_CSV',
    description:
      'Alias of OVERLORD_PROJECT_RESOURCES_PATHS, kept for backward compatibility. Same comma-separated `:rw`/`:ro`-suffixed paths. Useful for env vars that expect a CSV list (e.g. AGENT_POD_EXTRA_ALLOWED_PATHS).',
    example: '/repo/a:rw,/repo/b:ro',
    availableAt: ['plan_build', 'terminal_env'],
    format: 'comma-separated paths with :rw/:ro suffix'
  },
  {
    name: 'OVERLORD_PRIMARY_RESOURCE_PATH',
    description:
      'Absolute path of the primary (or else current) project resource when connected locally; empty string otherwise.',
    example: '/repo/a',
    availableAt: ['plan_build', 'terminal_env']
  }
] as const;

/** Names that may appear in `{VAR}` placeholders at plan-build time. */
export const LAUNCH_VARIABLE_NAMES: readonly string[] = LAUNCH_VARIABLES.filter(variable =>
  variable.availableAt.includes('plan_build')
).map(variable => variable.name);

/**
 * Attach-time context fields. These exist on the attach response after the agent
 * starts — they are NOT substituted into `{VAR}` placeholders during launch
 * preparation. Documented here so the settings UI and docs can explain the
 * boundary clearly.
 */
export const ATTACH_CONTEXT_FIELDS: readonly {
  name: string;
  description: string;
}[] = [
  {
    name: 'objective',
    description: 'Current objective (id, title, instruction text, state, resourceKey).'
  },
  {
    name: 'previousObjectives / futureObjectives',
    description: 'Ordered sibling objectives for mission context.'
  },
  {
    name: 'history',
    description: 'Recent mission events (updates, deliveries, asks, decisions).'
  },
  {
    name: 'artifacts / attachments / sharedState',
    description: 'Mission artifacts, objective attachments, and persistent shared context.'
  },
  {
    name: 'projectResources',
    description:
      'Same plural resource manifest as OVERLORD_PROJECT_RESOURCES — refreshed at attach for this execution target.'
  },
  {
    name: 'session.sessionKey',
    description: 'Session key required for subsequent protocol update/ask/deliver calls.'
  },
  {
    name: 'agentInstructions',
    description: 'Rendered workflow instructions for the attached agent.'
  }
];

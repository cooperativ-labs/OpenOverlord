/**
 * Per-project launch preparation: pre-launch commands and launch env vars.
 *
 * Pre-launch commands are ordered shell command lines configured on a project
 * (`ProjectDto.preLaunchCommands`) that the launch flow runs inside the agent's
 * launch environment — after the terminal enters the working directory and
 * exports the Overlord launch env, but before the agent process starts.
 *
 * Launch env vars (`ProjectDto.launchEnvVars`) are user-defined NAME=value pairs
 * exported into that same environment before both the pre-launch commands and
 * the agent.
 *
 * Both surfaces support `{VAR_NAME}` placeholders resolved against the launch
 * variable map built by `buildPreLaunchVariables`. The built-in catalog lives in
 * `@overlord/contract` (`LAUNCH_VARIABLES`); keep that list in sync with the
 * keys this module emits. The set remains open-ended — unknown placeholders are
 * left verbatim so mistyped or not-yet-wired names stay visible.
 */

/** `{VAR_NAME}` placeholder — upper snake-case, matching env-var conventions. */
const PLACEHOLDER_PATTERN = /\{([A-Z0-9_]+)\}/g;

/**
 * Replace `{VAR_NAME}` placeholders in each command with values from
 * `variables`, drop resulting blank lines, and return the runnable command
 * list. Unknown placeholders are left verbatim so a mistyped or not-yet-wired
 * variable is visible in the launched command rather than silently blanked.
 */
export function substitutePreLaunchVariables(
  commands: string[],
  variables: Record<string, string>
): string[] {
  return commands
    .map(command =>
      command.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
        const value = variables[name];
        return value === undefined ? match : value;
      })
    )
    .map(command => command.trim())
    .filter(command => command.length > 0);
}

/**
 * Substitute `{VAR_NAME}` placeholders in each launch env-var *value* from
 * `variables`, returning the resolved name→value map. Keys are trimmed and
 * blank-named entries dropped; a resolved value is kept verbatim (an empty
 * value is legitimate for an env var). Unknown placeholders are left verbatim so
 * a mistyped or not-yet-wired variable is visible rather than silently blanked.
 */
export function substituteLaunchEnvVars(
  envVars: Record<string, string>,
  variables: Record<string, string>
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(envVars)) {
    const key = rawKey.trim();
    if (!key) continue;
    resolved[key] = rawValue.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
      const value = variables[name];
      return value === undefined ? match : value;
    });
  }
  return resolved;
}

/** Non-empty resource filesystem paths from a project-resource manifest array. */
function resourcePaths(projectResources?: unknown[] | null): string[] {
  if (!Array.isArray(projectResources)) return [];
  const paths: string[] = [];
  for (const entry of projectResources) {
    if (entry && typeof entry === 'object') {
      const path = (entry as { path?: unknown }).path;
      if (typeof path === 'string' && path.trim()) paths.push(path.trim());
    }
  }
  return paths;
}

/** Absolute path of the primary resource, else the current one, else empty. */
function primaryResourcePath(projectResources?: unknown[] | null): string {
  if (!Array.isArray(projectResources)) return '';
  let currentPath = '';
  for (const entry of projectResources) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { path?: unknown; isPrimary?: unknown; isCurrent?: unknown };
    const path = typeof record.path === 'string' ? record.path.trim() : '';
    if (!path) continue;
    if (record.isPrimary === true) return path;
    if (record.isCurrent === true && !currentPath) currentPath = path;
  }
  return currentPath;
}

export type BuildPreLaunchVariablesInput = {
  /** Overlord-owned launch env already assembled for this plan (MISSION_ID, …). */
  launchEnv?: Record<string, string>;
  /** Project resource manifest for the launching execution target. */
  projectResources?: unknown[] | null;
  /** Absolute working directory the agent terminal will enter. */
  workingDirectory?: string | null;
  /** Absolute path to the written mission context markdown file. */
  contextFile?: string | null;
  /** Absolute path of the project `.overlord/tmp/` scratch directory. */
  tmpDir?: string | null;
};

/**
 * Build the placeholder → value map for launch-preparation substitution from the
 * resolved launch context. Seeds from the Overlord launch env plus derived
 * convenience variables. This is the single place new launch variables get
 * exposed to `{VAR}` placeholders — extend it (and `LAUNCH_VARIABLES` in
 * `@overlord/contract`) as more context becomes available at plan-build time.
 *
 * Documented optional variables that are absent from the current launch resolve
 * to an empty string (so `{OVERLORD_EXECUTION_REQUEST_ID}` does not stay as a
 * literal token when the launch is not runner-driven). Truly unknown names are
 * still left verbatim by the substituters.
 */
export function buildPreLaunchVariables({
  launchEnv = {},
  projectResources,
  workingDirectory,
  contextFile,
  tmpDir
}: BuildPreLaunchVariablesInput): Record<string, string> {
  const paths = resourcePaths(projectResources);
  const scratch = typeof tmpDir === 'string' ? tmpDir.trim() : '';
  const cwd = typeof workingDirectory === 'string' ? workingDirectory.trim() : '';
  const contextPath = typeof contextFile === 'string' ? contextFile.trim() : '';

  return {
    // Optional Overlord env keys default to empty so documented placeholders
    // resolve rather than remaining as literal `{VAR}` tokens.
    OVERLORD_EXECUTION_REQUEST_ID: '',
    OVERLORD_PROJECT_RESOURCES: '',
    ...launchEnv,
    OVERLORD_PROJECT_RESOURCES_PATHS: paths.join(' '),
    OVERLORD_PROJECT_RESOURCES_PATHS_CSV: paths.join(','),
    OVERLORD_PRIMARY_RESOURCE_PATH: primaryResourcePath(projectResources),
    OVERLORD_WORKING_DIRECTORY: cwd,
    OVERLORD_CONTEXT_FILE: contextPath,
    OVERLORD_TMPDIR: scratch,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch
  };
}

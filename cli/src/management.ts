import { createInterface } from 'node:readline/promises';

import { flagBoolean, flagValue, parseArgs } from './args.js';
import { CliError } from './errors.js';
import { printJson } from './output.js';

type BackendConfigResult = {
  configPath: string;
  mode: 'local' | 'cloud';
  url: string;
};

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

async function promptLine({
  message,
  defaultValue
}: {
  message: string;
  defaultValue?: string;
}): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError({
      message:
        'Interactive backend configuration requires a TTY. Run `ovld config set local [url]` or `ovld config set cloud <url>`.'
    });
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = await rl.question(`${message}${suffix}: `);
    return answer.trim() || defaultValue || '';
  } finally {
    rl.close();
  }
}

async function configureBackendInteractive(): Promise<BackendConfigResult> {
  const { DEFAULT_LOCAL_BACKEND_URL, loadConfig, resolveConfigWritePath, writeConfig } =
    await import('./config.js');

  console.log('Choose an Overlord backend before continuing.');
  console.log(
    'Use local for a Desktop/local backend on this machine, or cloud for a hosted Overlord backend.'
  );

  const type = (
    await promptLine({
      message: 'Backend type (local/cloud)',
      defaultValue: 'local'
    })
  ).toLowerCase();
  const targetPath = resolveConfigWritePath();
  const current = loadConfig(targetPath);

  if (type === 'cloud') {
    const cloudUrl = await promptLine({ message: 'Cloud backend URL' });
    if (!cloudUrl) throw new CliError({ message: 'Cloud backend URL is required.' });
    if (!isHttpUrl(cloudUrl)) {
      throw new CliError({
        message: 'Cloud backend must be an http:// or https:// URL.'
      });
    }
    writeConfig({
      targetPath,
      config: { ...current, backendMode: 'cloud', backendUrl: cloudUrl }
    });
    return { configPath: targetPath, mode: 'cloud', url: cloudUrl };
  }

  if (type !== 'local') {
    throw new CliError({ message: 'Backend type must be `local` or `cloud`.' });
  }

  const localUrl = await promptLine({
    message: 'Local backend URL',
    defaultValue: DEFAULT_LOCAL_BACKEND_URL
  });
  if (!isHttpUrl(localUrl)) {
    throw new CliError({ message: 'Local backend must be an http:// or https:// URL.' });
  }
  writeConfig({
    targetPath,
    config: { ...current, backendMode: 'local', backendUrl: localUrl }
  });
  return { configPath: targetPath, mode: 'local', url: localUrl };
}

async function configureBackendFromArgs({
  parsed,
  json
}: {
  parsed: ReturnType<typeof parseArgs>;
  json: boolean;
}): Promise<void> {
  const {
    DEFAULT_LOCAL_BACKEND_URL,
    findEffectiveConfigPath,
    loadConfig,
    resolveConfigWritePath,
    resolveBackendUrl,
    writeConfig
  } = await import('./config.js');

  const sub = parsed.positional[0] ?? 'list';
  const targetPath = resolveConfigWritePath();
  const current = loadConfig(targetPath);

  if (sub === 'list') {
    const effectivePath = findEffectiveConfigPath();
    const mode = current.backendUrl ? current.backendMode : 'unset';
    const backendUrl = resolveBackendUrl(current);
    if (json) {
      printJson({
        config: current,
        path: effectivePath,
        backend: {
          configured: mode !== 'unset',
          mode,
          url: backendUrl
        }
      });
    } else {
      console.log(`config_path=${effectivePath ?? '(not configured)'}`);
      console.log(`backend_mode=${mode}`);
      console.log(`backend_url=${backendUrl}`);
      console.log(`web_host=${current.webHost}`);
      console.log(`web_port=${current.webPort}`);
      console.log(`default_agent=${current.defaultAgent}`);
    }
    return;
  }

  if (sub === 'get') {
    const key = parsed.positional[1] ?? 'backend';
    const values: Record<string, string | number | boolean | null> = {
      backend: current.backendUrl ?? `default local (${DEFAULT_LOCAL_BACKEND_URL})`,
      backend_mode: current.backendMode,
      backend_url: resolveBackendUrl(current),
      web_host: current.webHost,
      web_port: current.webPort,
      default_agent: current.defaultAgent
    };
    if (!(key in values)) throw new CliError({ message: `Unknown config key: ${key}` });
    if (json) printJson({ key, value: values[key] });
    else console.log(`${key}=${values[key] ?? ''}`);
    return;
  }

  if (sub !== 'set') {
    throw new CliError({
      message:
        'Usage: ovld config list|get <key>|set [local <path>|cloud <postgres-url>|database_path <path>|database_url <postgres-url>]'
    });
  }

  const target = parsed.positional[1];
  const value =
    parsed.positional[2] ?? flagValue(parsed.flags, '--path') ?? flagValue(parsed.flags, '--url');

  let result: BackendConfigResult;
  if (!target) {
    result = await configureBackendInteractive();
  } else if (target === 'local' || target === 'backend_url') {
    const backendUrl = value?.trim() || DEFAULT_LOCAL_BACKEND_URL;
    if (!isHttpUrl(backendUrl)) {
      throw new CliError({ message: 'Local backend must be an http:// or https:// URL.' });
    }
    writeConfig({
      targetPath,
      config: { ...current, backendMode: 'local', backendUrl }
    });
    result = { configPath: targetPath, mode: 'local', url: backendUrl };
  } else if (target === 'cloud') {
    if (!value) throw new CliError({ message: 'Cloud backend URL is required.' });
    if (!isHttpUrl(value)) {
      throw new CliError({
        message: 'Cloud backend must be an http:// or https:// URL.'
      });
    }
    writeConfig({
      targetPath,
      config: { ...current, backendMode: 'cloud', backendUrl: value }
    });
    result = { configPath: targetPath, mode: 'cloud', url: value };
  } else {
    throw new CliError({
      message: 'Usage: ovld config set [local <url>|cloud <url>]'
    });
  }

  if (json) printJson(result);
  else {
    console.log(`Configured ${result.mode} backend at ${result.url}`);
    console.log(`Wrote ${result.configPath}`);
  }
}

async function runAuthStatusCommand({ json }: { json: boolean }): Promise<void> {
  const { resolveAuthStatus } = await import('./auth-status.js');
  const status = await resolveAuthStatus();

  if (json) {
    printJson(status);
    return;
  }

  console.log(`backend_url=${status.backendUrl}`);
  console.log(`backend_mode=${status.backendMode}`);
  console.log(`config_path=${status.configPath ?? '(not configured)'}`);
  console.log(`logged_in=${status.loggedIn ? 'true' : 'false'}`);
  console.log(`credential_source=${status.credentialSource}`);
  if (status.credentialType) console.log(`credential_type=${status.credentialType}`);
  if (status.credentialsPath) console.log(`credentials_path=${status.credentialsPath}`);
  if (status.validationError) console.log(`validation_error=${status.validationError}`);
}

async function runAuthCommand({ rest, json }: { rest: string[]; json: boolean }): Promise<void> {
  const parsed = parseArgs(rest);
  const sub = parsed.positional[0] ?? 'login';

  if (sub === 'status') {
    await runAuthStatusCommand({ json });
    return;
  }

  if (sub !== 'login') {
    throw new CliError({
      message: 'Usage: ovld auth login [--token <out_...>] | ovld auth status [--json]'
    });
  }

  const tokenFlag = flagValue(parsed.flags, '--token');

  const { findEffectiveConfigPath, hasExplicitBackendConfig, loadConfig } =
    await import('./config.js');
  let config = loadConfig();
  let configPath = findEffectiveConfigPath();
  let configured = hasExplicitBackendConfig(config);
  let setup: BackendConfigResult | null = null;

  if (!configured) {
    setup = await configureBackendInteractive();
    config = loadConfig(setup.configPath);
    configPath = setup.configPath;
    configured = hasExplicitBackendConfig(config);
  }

  if (!configured)
    throw new CliError({ message: 'Backend configuration is required before login.' });

  const { resolveBackendUrl } = await import('./config.js');
  const mode = config.backendMode;
  const backendUrl = resolveBackendUrl(config);
  const { loginWithUserToken, runInteractiveAuthLogin } = await import('./auth-login.js');
  const login = tokenFlag
    ? await loginWithUserToken({ backendUrl, token: tokenFlag })
    : await runInteractiveAuthLogin({
        backendUrl,
        passwordCredentialTarget: mode === 'cloud' ? 'full_user_token' : 'session_bearer'
      });

  if (json) {
    printJson({
      ...login,
      backend: {
        mode,
        url: backendUrl,
        configPath
      },
      configuredDuringLogin: setup !== null
    });
  } else {
    const methodLabel = login.authMethod === 'user_token' ? 'USER_TOKEN' : 'email and password';
    console.log(`Logged in to ${backendUrl} using ${methodLabel}.`);
    console.log(`Saved credentials to ${login.credentialsPath}`);
  }
}

/**
 * Local management commands that do NOT require the database/service layer:
 * `update`, `init`, `doctor`, `setup`, `agent-setup`, `config`, `auth login`, and `auth status`. These are dispatched separately from the
 * DB-backed commands in `commands.ts` so they never statically import the
 * service layer — keeping them runnable from a globally installed `ovld`
 * binary (where the root project `dist/` is not on disk).
 */
export async function runLocalCommand({
  command,
  rest
}: {
  command: string;
  rest: string[];
}): Promise<void> {
  const parsed = parseArgs(rest);
  const json = flagBoolean(parsed.flags, '--json');

  switch (command) {
    case 'update': {
      const { runUpdateCommand } = await import('./update.js');
      await runUpdateCommand({ rest });
      return;
    }
    case 'init': {
      const {
        DEFAULT_LOCAL_BACKEND_URL,
        writeConfig,
        resolveRepoPath,
        loadConfig,
        resolveBackendUrl
      } = await import('./config.js');
      const target = resolveRepoPath('overlord.toml');
      writeConfig({
        targetPath: target,
        config: {
          instanceName: 'Local Overlord',
          backendMode: 'local',
          backendUrl: DEFAULT_LOCAL_BACKEND_URL
        }
      });
      // Report the URL that will actually be used: in development a repo-local
      // `OVERLORD_BACKEND_URL_DEV` (.env.local) overrides the toml default.
      const backendUrl = resolveBackendUrl(loadConfig(target));
      if (json) {
        printJson({ ok: true, configPath: target, backendUrl });
      } else {
        console.log(`Initialized Overlord at ${target}`);
        console.log(`Configured local backend at ${backendUrl}`);
      }
      return;
    }
    case 'setup': {
      const { runSetupCommand } = await import('./setup.js');
      await runSetupCommand({ rest, json });
      return;
    }
    case 'agent-setup': {
      const { runAgentSetupCommand } = await import('./setup.js');
      await runAgentSetupCommand({ rest, json });
      return;
    }
    case 'config': {
      await configureBackendFromArgs({ parsed, json });
      return;
    }
    case 'auth': {
      await runAuthCommand({ rest, json });
      return;
    }
    case 'user-token': {
      const { runUserTokenCommand } = await import('./user-token.js');
      await runUserTokenCommand({ rest });
      return;
    }
    case 'prune': {
      const { pruneProjectTmpContents } = await import('./project-tmp.js');
      const workingDirectory = process.cwd();
      const result = pruneProjectTmpContents(workingDirectory);
      if (json) {
        printJson({ ok: true, ...result });
      } else if (result.warned) {
        console.warn('Warning: no .overlord folder found in the current directory.');
      } else {
        console.log(`Removed ${result.removedCount} item(s) from .overlord/tmp.`);
      }
      return;
    }
    case 'doctor': {
      const { createBackendClient } = await import('./backend-client.js');
      const { inspectConnector, listAvailableConnectors } = await import('./connectors.js');
      const backend = createBackendClient();
      const health = await backend.health().catch(error => ({
        ok: false,
        detail: error instanceof Error ? error.message : String(error)
      }));
      const checks: Array<{ name: string; ok: boolean; required: boolean; detail: string }> = [
        {
          name: 'backend',
          ok: health.ok,
          required: true,
          detail: health.ok ? backend.baseUrl : `Backend unreachable at ${backend.baseUrl}`
        }
      ];

      for (const agentKey of listAvailableConnectors()) {
        const report = inspectConnector({ agentKey });
        if (!report.installed) {
          checks.push({
            name: `connector:${agentKey}`,
            ok: true,
            required: false,
            detail: `not installed — run \`ovld agent-setup ${agentKey}\``
          });
        } else {
          checks.push({
            name: `connector:${agentKey}`,
            ok: report.healthy,
            required: true,
            detail: report.healthy
              ? `installed at ${report.installPath}`
              : report.problems.join('; ')
          });
        }
        checks.push({
          name: `agent-binary:${report.binaryName}`,
          ok: report.binaryFound,
          required: false,
          detail: report.binaryFound
            ? `found on PATH`
            : `not found on PATH (install ${report.binaryName} to launch this agent)`
        });
      }

      // Warn when the credentials directory is nested inside a cloud-sync root,
      // which silently replicates the plaintext `auth.json` token off-device
      // (security audit 2026-06-18).
      {
        const pathMod = await import('node:path');
        const { authCredentialsPath } = await import('./auth-credentials.js');
        const { detectCloudSyncRoot } = await import('./sync-root.js');
        const credentialsDir = pathMod.dirname(authCredentialsPath());
        const syncMatch = detectCloudSyncRoot(credentialsDir);
        checks.push({
          name: 'credentials-sync-root',
          ok: syncMatch === null,
          required: false,
          detail:
            syncMatch === null
              ? `${credentialsDir} is not inside a known cloud-sync folder`
              : `${credentialsDir} is inside ${syncMatch.provider} (${syncMatch.matchedSegment}); the plaintext token is replicated to cloud storage. Relocate it with OVLD_HOME or exclude this folder from sync.`
        });
      }

      if (health.ok) {
        const { isLoopbackBackendUrl } = await import('./config.js');
        const { readStoredAuthCredentials } = await import('./auth-credentials.js');
        const { buildExecutionTargetMigrationDoctorCheck } =
          await import('./execution-target-migration-doctor.js');
        const hasAuth =
          Boolean(
            process.env.OVERLORD_USER_TOKEN?.trim() ||
            process.env.OVLD_USER_TOKEN?.trim() ||
            process.env.USER_TOKEN?.trim()
          ) || readStoredAuthCredentials() !== null;
        if (hasAuth && !isLoopbackBackendUrl(backend.baseUrl)) {
          try {
            const diagnostics = await backend.get<
              import('./execution-target-migration-doctor.js').ExecutionTargetMigrationDiagnostics
            >('/api/diagnostics/execution-target-migration');
            const migrationCheck = buildExecutionTargetMigrationDoctorCheck({ diagnostics });
            if (migrationCheck) checks.push(migrationCheck);
          } catch {
            // Older backends may not expose migration diagnostics yet.
          }
        }
      }

      const allOk = checks.every(check => !check.required || check.ok);
      if (json) {
        printJson({ ok: allOk, checks });
      } else {
        for (const check of checks) {
          const status = check.ok ? 'ok' : check.required ? 'fail' : 'warn';
          console.log(`${status} ${check.name}: ${check.detail}`);
        }
      }
      if (!allOk) {
        throw new CliError({ message: 'Doctor found problems. Fix the items above and retry.' });
      }
      return;
    }
    default:
      throw new CliError({ message: `Unknown command: ${command}` });
  }
}

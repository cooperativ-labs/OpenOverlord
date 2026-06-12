import { existsSync } from 'node:fs';

import { flagBoolean, parseArgs } from './args.js';
import { CliError } from './errors.js';
import { printJson } from './output.js';

/**
 * Local management commands that do NOT require the database/service layer:
 * `init`, `doctor`, and `setup`. These are dispatched separately from the
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
    case 'init': {
      const { writeConfig, loadConfig, resolveDatabasePath, resolveRepoPath } =
        await import('./config.js');
      const { migrateDatabase, openDatabase } = await import('@overlord/database');
      const target = resolveRepoPath('overlord.toml');
      writeConfig({ targetPath: target, config: { instanceName: 'Local Overlord' } });
      const dbPath = resolveDatabasePath(loadConfig(target));
      const db = openDatabase({ databasePath: dbPath });
      migrateDatabase(db);
      db.close();
      if (json) {
        printJson({ ok: true, configPath: target, databasePath: dbPath });
      } else {
        console.log(`Initialized Overlord at ${target}`);
        console.log(`Database ready at ${dbPath}`);
      }
      return;
    }
    case 'setup': {
      const { runSetupCommand } = await import('./setup.js');
      await runSetupCommand({ rest, json });
      return;
    }
    case 'doctor': {
      const { loadConfig, resolveDatabasePath } = await import('./config.js');
      const { inspectConnector, listAvailableConnectors } = await import('./connectors.js');
      const config = loadConfig();
      const dbPath = resolveDatabasePath(config);
      const checks: Array<{ name: string; ok: boolean; required: boolean; detail: string }> = [
        {
          name: 'database',
          ok: existsSync(dbPath),
          required: true,
          detail: existsSync(dbPath) ? dbPath : `Missing database at ${dbPath}`
        }
      ];

      for (const agentKey of listAvailableConnectors()) {
        const report = inspectConnector({ agentKey });
        if (!report.installed) {
          checks.push({
            name: `connector:${agentKey}`,
            ok: true,
            required: false,
            detail: `not installed — run \`ovld setup ${agentKey}\``
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

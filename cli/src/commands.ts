import { getDevice, updateDevice } from '../../src/service/devices.js';
import { ServiceError } from '../../src/service/errors.js';
import {
  addProjectResource,
  createProject,
  discoverProject,
  listOrganizations,
  listProjectResources
} from '../../src/service/projects.js';
import {
  addObjectivesToTicket,
  askQuestion,
  attachSession,
  authStatus,
  connectSession,
  deliverSession,
  discussObjective,
  heartbeatSession,
  listSharedContext,
  loadTicketContext,
  protocolCreate,
  protocolPrompt,
  recordWork,
  searchTickets,
  updateSession,
  writeSharedContext
} from '../../src/service/protocol.js';
import { listTickets } from '../../src/service/tickets.js';

import {
  flagBoolean,
  flagValue,
  parseArgs,
  parseCsvFlag,
  parseJsonFlag,
  readFlagOrFile,
  requireFlag
} from './args.js';
import { CliError } from './errors.js';
import { printJson, printKeyValue } from './output.js';
import type { CliRuntime } from './runtime.js';

function handleServiceError(error: unknown): never {
  if (error instanceof ServiceError) {
    throw new CliError({ message: error.message });
  }
  throw error;
}

function mapStatusNames(statusCsv: string | undefined): string[] | undefined {
  if (!statusCsv) return undefined;
  return parseCsvFlag(statusCsv)?.map(status => {
    if (status === 'next-up') return 'draft';
    return status;
  });
}

export async function runProtocolCommand({
  runtime,
  subcommand,
  args,
  stdin
}: {
  runtime: CliRuntime;
  subcommand: string;
  args: string[];
  stdin?: string;
}): Promise<void> {
  const parsed = parseArgs(args);
  const { ctx } = runtime;

  try {
    switch (subcommand) {
      case 'auth-status': {
        printJson(authStatus({ ctx }));
        return;
      }
      case 'discover-project': {
        const result = discoverProject({
          ctx,
          workingDirectory: flagValue(parsed.flags, '--working-directory'),
          projectId: flagValue(parsed.flags, '--project-id')
        });
        printJson(result);
        return;
      }
      case 'list-organizations': {
        printJson({ organizations: listOrganizations({ ctx }) });
        return;
      }
      case 'create': {
        const objective = requireFlag(parsed.flags, '--objective');
        const result = protocolCreate({
          ctx,
          projectId: flagValue(parsed.flags, '--project-id'),
          objective,
          title: flagValue(parsed.flags, '--title')
        });
        printJson(result);
        return;
      }
      case 'prompt': {
        const objective = parsed.positional[0] ?? flagValue(parsed.flags, '--objective');
        if (!objective) {
          throw new CliError({ message: 'Missing objective text or --objective flag' });
        }
        const result = protocolPrompt({
          ctx,
          projectId: flagValue(parsed.flags, '--project-id'),
          objective,
          title: flagValue(parsed.flags, '--title'),
          agentIdentifier: flagValue(parsed.flags, '--agent') ?? 'unknown'
        });
        printKeyValue({
          SESSION_KEY: result.sessionKey,
          TICKET_ID: result.ticket.displayId,
          PROJECT_ID: result.ticket.projectId
        });
        printJson(result);
        return;
      }
      case 'load-context': {
        const ticketId = requireFlag(parsed.flags, '--ticket-id');
        const context = loadTicketContext({ ctx, ticketId });
        printJson(context);
        return;
      }
      case 'connect': {
        const ticketId = requireFlag(parsed.flags, '--ticket-id');
        const result = connectSession({
          ctx,
          ticketId,
          agentIdentifier: flagValue(parsed.flags, '--agent') ?? 'unknown'
        });
        printKeyValue({
          SESSION_KEY: result.sessionKey,
          TICKET_ID: ticketId,
          OBJECTIVE_ID: result.objectiveId
        });
        printJson(result);
        return;
      }
      case 'search-tickets': {
        const tickets = searchTickets({
          ctx,
          query: flagValue(parsed.flags, '--query'),
          projectId: flagValue(parsed.flags, '--project-id'),
          statusTypes: mapStatusNames(flagValue(parsed.flags, '--status')),
          limit: Number.parseInt(flagValue(parsed.flags, '--limit') ?? '25', 10)
        });
        printJson({ tickets });
        return;
      }
      case 'discuss-objective': {
        const ticketId = requireFlag(parsed.flags, '--ticket-id');
        const objective = discussObjective({ ctx, ticketId });
        printJson({ objective });
        return;
      }
      case 'add-objectives': {
        const ticketId = requireFlag(parsed.flags, '--ticket-id');
        const raw = requireFlag(parsed.flags, '--objectives-json');
        const objectives = JSON.parse(raw) as Array<{ objective: string; title?: string }>;
        const created = addObjectivesToTicket({ ctx, ticketId, objectives });
        printJson({ objectives: created });
        return;
      }
      case 'attach': {
        const ticketId = requireFlag(parsed.flags, '--ticket-id');
        const result = attachSession({
          ctx,
          ticketId,
          existingSessionKey: flagValue(parsed.flags, '--session-key'),
          agentIdentifier: flagValue(parsed.flags, '--agent') ?? 'unknown',
          modelIdentifier: flagValue(parsed.flags, '--model')
        });
        printKeyValue({
          SESSION_KEY: result.sessionKey,
          TICKET_ID: result.ticket.displayId,
          OBJECTIVE_ID: result.objective.id
        });
        printJson(result);
        return;
      }
      case 'update': {
        const ticketId = requireFlag(parsed.flags, '--ticket-id');
        const sessionKey = requireFlag(parsed.flags, '--session-key');
        const summary = await readFlagOrFile({
          flags: parsed.flags,
          flagName: '--summary',
          fileFlagName: '--summary-file',
          stdin
        });
        if (!summary) {
          throw new CliError({ message: 'Missing --summary or --summary-file' });
        }

        const changedFilesRaw =
          flagValue(parsed.flags, '--changed-files-json') ??
          (flagValue(parsed.flags, '--changed-files-file') === '-' ? stdin : undefined);

        const rationalesRaw =
          flagValue(parsed.flags, '--change-rationales-json') ??
          (flagValue(parsed.flags, '--change-rationales-file') === '-' ? stdin : undefined);

        const result = updateSession({
          ctx,
          ticketId,
          sessionKey,
          summary,
          phase: flagValue(parsed.flags, '--phase'),
          eventType: flagValue(parsed.flags, '--event-type'),
          payloadJson: parseJsonFlag(parsed.flags, '--payload-json'),
          externalUrl: flagValue(parsed.flags, '--external-url'),
          externalSessionId: flagValue(parsed.flags, '--external-session-id'),
          beginFollowUpWork: flagBoolean(parsed.flags, '--begin-follow-up-work'),
          followUpIntent: flagValue(parsed.flags, '--follow-up-intent'),
          changedFiles: changedFilesRaw
            ? (JSON.parse(changedFilesRaw) as Array<{ filePath: string; vcsStatus?: string }>)
            : undefined,
          changeRationales: rationalesRaw
            ? (JSON.parse(rationalesRaw) as Array<Record<string, unknown>>)
            : undefined
        });
        printJson(result);
        return;
      }
      case 'heartbeat': {
        const ticketId = requireFlag(parsed.flags, '--ticket-id');
        const sessionKey = requireFlag(parsed.flags, '--session-key');
        const result = heartbeatSession({
          ctx,
          ticketId,
          sessionKey,
          phase: flagValue(parsed.flags, '--phase'),
          note: flagValue(parsed.flags, '--note')
        });
        printJson(result);
        return;
      }
      case 'ask': {
        const ticketId = requireFlag(parsed.flags, '--ticket-id');
        const sessionKey = requireFlag(parsed.flags, '--session-key');
        const question = await readFlagOrFile({
          flags: parsed.flags,
          flagName: '--question',
          fileFlagName: '--question-file',
          stdin
        });
        if (!question) {
          throw new CliError({ message: 'Missing --question or --question-file' });
        }
        const result = askQuestion({ ctx, ticketId, sessionKey, question });
        printJson(result);
        return;
      }
      case 'deliver': {
        const ticketId = requireFlag(parsed.flags, '--ticket-id');
        const sessionKey = requireFlag(parsed.flags, '--session-key');
        const summary = await readFlagOrFile({
          flags: parsed.flags,
          flagName: '--summary',
          fileFlagName: '--summary-file',
          stdin
        });
        if (!summary) {
          throw new CliError({ message: 'Missing --summary or --summary-file' });
        }

        const rationalesRaw = flagValue(parsed.flags, '--change-rationales-json');
        const artifactsRaw = flagValue(parsed.flags, '--artifacts');

        const result = deliverSession({
          ctx,
          ticketId,
          sessionKey,
          summary,
          artifacts: artifactsRaw
            ? (JSON.parse(artifactsRaw) as Array<{
                type: string;
                label: string;
                content?: string;
                url?: string;
              }>)
            : [],
          changeRationales: rationalesRaw
            ? (JSON.parse(rationalesRaw) as Array<{
                file_path: string;
                label: string;
                summary: string;
                why: string;
                impact: string;
              }>)
            : [],
          payloadJson: parseJsonFlag(parsed.flags, '--payload-json'),
          verificationSummary: flagValue(parsed.flags, '--verification-summary'),
          followUpNotes: flagValue(parsed.flags, '--follow-up-notes')
        });
        printJson(result);
        return;
      }
      case 'read-context': {
        const ticketId = requireFlag(parsed.flags, '--ticket-id');
        const entries = listSharedContext({
          ctx,
          ticketId,
          keySubstring: flagValue(parsed.flags, '--key'),
          limit: Number.parseInt(flagValue(parsed.flags, '--limit') ?? '50', 10)
        });
        printJson({ entries });
        return;
      }
      case 'write-context': {
        const ticketId = requireFlag(parsed.flags, '--ticket-id');
        const key = requireFlag(parsed.flags, '--key');
        const valueRaw = requireFlag(parsed.flags, '--value-json');
        const entry = writeSharedContext({
          ctx,
          ticketId,
          key,
          value: JSON.parse(valueRaw) as unknown,
          tags: parseCsvFlag(flagValue(parsed.flags, '--tags')) ?? []
        });
        printJson({ entry });
        return;
      }
      case 'record-work': {
        const summary = await readFlagOrFile({
          flags: parsed.flags,
          flagName: '--summary',
          fileFlagName: '--summary-file',
          stdin
        });
        const objective = flagValue(parsed.flags, '--objective');
        if (!summary || !objective) {
          throw new CliError({ message: 'record-work requires --summary and --objective' });
        }
        const result = recordWork({
          ctx,
          projectId: flagValue(parsed.flags, '--project-id'),
          summary,
          objective,
          title: flagValue(parsed.flags, '--title')
        });
        printJson(result);
        return;
      }
      case 'get-device': {
        printJson(getDevice({ ctx }));
        return;
      }
      case 'update-device': {
        const deviceId = requireFlag(parsed.flags, '--device-id');
        const label = requireFlag(parsed.flags, '--label');
        printJson(updateDevice({ ctx, deviceId, label }));
        return;
      }
      case 'create-project': {
        const name = requireFlag(parsed.flags, '--name');
        const project = createProject({
          ctx,
          name,
          description: flagValue(parsed.flags, '--description')
        });
        printJson({ project });
        return;
      }
      case 'list-project-resources': {
        const projectId = requireFlag(parsed.flags, '--project-id');
        printJson({ resources: listProjectResources({ ctx, projectId }) });
        return;
      }
      case 'add-project-resource': {
        const projectId = requireFlag(parsed.flags, '--project-id');
        const directory = requireFlag(parsed.flags, '--directory');
        const resource = addProjectResource({
          ctx,
          projectId,
          directoryPath: directory,
          label: flagValue(parsed.flags, '--label'),
          isPrimary: flagValue(parsed.flags, '--primary') !== 'false'
        });
        printJson({ resource });
        return;
      }
      case 'help':
      case '--help':
      case '-h': {
        printJson({
          commands: [
            'auth-status',
            'discover-project',
            'list-organizations',
            'create',
            'prompt',
            'load-context',
            'connect',
            'search-tickets',
            'discuss-objective',
            'add-objectives',
            'attach',
            'update',
            'heartbeat',
            'ask',
            'deliver',
            'read-context',
            'write-context',
            'record-work',
            'get-device',
            'update-device',
            'create-project',
            'list-project-resources',
            'add-project-resource'
          ]
        });
        return;
      }
      default:
        throw new CliError({
          message: `Unknown protocol command: ${subcommand}\nRun \`ovld protocol help\` for usage.`
        });
    }
  } catch (error) {
    handleServiceError(error);
  }
}

export async function runManagementCommand({
  runtime,
  command,
  rest
}: {
  runtime?: CliRuntime;
  command: string;
  rest: string[];
}): Promise<void> {
  const parsed = parseArgs(rest);
  const json = flagBoolean(parsed.flags, '--json');

  if (!runtime) {
    throw new CliError({ message: `Command requires a database: ${command}` });
  }
  const { ctx } = runtime;

  try {
    switch (command) {
      case 'create-project': {
        const name = flagValue(parsed.flags, '--name') ?? parsed.positional.join(' ');
        if (!name) throw new CliError({ message: 'Missing --name' });
        const project = createProject({ ctx, name });
        if (!flagBoolean(parsed.flags, '--no-directory')) {
          const directory = flagValue(parsed.flags, '--directory') ?? process.cwd();
          addProjectResource({
            ctx,
            projectId: project.id,
            directoryPath: directory,
            isPrimary: true
          });
        }
        if (json) printJson({ project });
        else console.log(`Created project ${project.name} (${project.id})`);
        return;
      }
      case 'add-cwd': {
        const directory = flagValue(parsed.flags, '--directory') ?? process.cwd();
        let projectId = flagValue(parsed.flags, '--project-id');
        if (!projectId) {
          try {
            projectId = discoverProject({ ctx }).projectId;
          } catch {
            const latest = ctx.db
              .prepare(
                `SELECT id FROM projects WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`
              )
              .get(ctx.workspace.id) as { id: string } | undefined;
            if (!latest) {
              throw new CliError({
                message: 'No project found. Create one with `ovld create-project`.'
              });
            }
            projectId = latest.id;
          }
        }
        const resource = addProjectResource({
          ctx,
          projectId,
          directoryPath: directory,
          isPrimary: flagValue(parsed.flags, '--primary') !== 'false'
        });
        if (json) printJson({ resource });
        else console.log(`Linked ${directory} to project ${projectId}`);
        return;
      }
      case 'create': {
        const objectivesJson = flagValue(parsed.flags, '--objectives-json');
        const text = parsed.positional.join(' ') || flagValue(parsed.flags, '--objective');
        const discovery = discoverProject({ ctx });
        if (objectivesJson) {
          const objectives = JSON.parse(objectivesJson) as Array<{
            objective: string;
            title?: string;
          }>;
          const { createTicketWithObjectives } = await import('../../src/service/tickets.js');
          const result = createTicketWithObjectives({
            ctx,
            projectId: discovery.projectId,
            objectives: objectives.map(item => ({ objective: item.objective, title: item.title }))
          });
          if (json) printJson(result);
          else console.log(`Created ticket ${result.ticket.displayId}`);
          return;
        }
        if (!text)
          throw new CliError({ message: 'Provide an objective string or --objectives-json' });
        const result = protocolCreate({ ctx, projectId: discovery.projectId, objective: text });
        if (json) printJson(result);
        else console.log(`Created draft ticket ${result.ticket.displayId}`);
        return;
      }
      case 'prompt': {
        const text = parsed.positional.join(' ');
        if (!text) throw new CliError({ message: 'Missing objective prompt text' });
        const result = protocolPrompt({ ctx, objective: text });
        printKeyValue({
          SESSION_KEY: result.sessionKey,
          TICKET_ID: result.ticket.displayId
        });
        if (json) printJson(result);
        else console.log(`Created and attached ticket ${result.ticket.displayId}`);
        return;
      }
      case 'tickets': {
        const sub = parsed.positional[0];
        if (sub !== 'list') {
          throw new CliError({
            message: 'Usage: ovld tickets list [--status <csv>] [--project-id <id>] [--json]'
          });
        }
        const tickets = listTickets({
          ctx,
          projectId: flagValue(parsed.flags, '--project-id'),
          statusTypes: mapStatusNames(flagValue(parsed.flags, '--status')),
          limit: Number.parseInt(flagValue(parsed.flags, '--limit') ?? '50', 10)
        });
        if (json) printJson({ tickets });
        else {
          for (const ticket of tickets) {
            console.log(`${ticket.displayId}\t${ticket.statusType}\t${ticket.title}`);
          }
        }
        return;
      }
      case 'ticket': {
        const sub = parsed.positional[0];
        const ticketId = parsed.positional[1];
        if (sub !== 'context' || !ticketId) {
          throw new CliError({ message: 'Usage: ovld ticket context <ticketId> [--json]' });
        }
        const context = loadTicketContext({ ctx, ticketId });
        if (json) printJson(context);
        else {
          console.log(context.promptContext);
        }
        return;
      }
      case 'config': {
        const sub = parsed.positional[0] ?? 'list';
        const { loadConfig, findConfigPath } = await import('./config.js');
        const config = loadConfig();
        if (sub === 'list') {
          if (json) printJson({ config, path: findConfigPath() });
          else {
            console.log(`instance_name=${config.instanceName}`);
            console.log(`database_path=${config.databasePath}`);
            console.log(`web_port=${config.webPort}`);
            console.log(`default_agent=${config.defaultAgent}`);
          }
          return;
        }
        throw new CliError({ message: `Unknown config subcommand: ${sub}` });
      }
      default:
        throw new CliError({ message: `Unknown command: ${command}` });
    }
  } catch (error) {
    handleServiceError(error);
  }
}

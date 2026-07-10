export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false
  };
}

const stringProperty = (description: string): Record<string, unknown> => ({
  type: 'string',
  description
});

const protocolOutputSchema = (description: string): Record<string, unknown> => ({
  type: 'object',
  description,
  additionalProperties: true
});

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const writeAction = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

function widget(uri: string): Record<string, unknown> {
  return {
    'openai/outputTemplate': uri,
    ui: { resourceUri: uri }
  };
}

export const hostedMcpToolDefinitions: ToolDefinition[] = [
  {
    name: 'overlord_resolve_project',
    title: 'Resolve Overlord project',
    description:
      'Use this when the user identifies an Overlord project by id, slug, name, or exposed repository metadata.',
    inputSchema: objectSchema({
      projectId: stringProperty('Explicit Overlord project id, slug, or project name.'),
      directory: stringProperty(
        'Optional repository directory path when the MCP client can expose one with .overlord/project.json.'
      )
    }),
    outputSchema: protocolOutputSchema('Resolved Overlord project metadata.'),
    annotations: readOnly,
    _meta: widget('ui://overlord/project-selector.html')
  },
  {
    name: 'overlord_search_missions',
    title: 'Search Overlord missions',
    description:
      'Use this when the user wants to find or list missions in the connected workspace.',
    inputSchema: objectSchema({
      query: stringProperty('Search query text.'),
      status: stringProperty('Comma-separated status types, such as draft,execute,review.'),
      projectId: stringProperty('Optional project id, slug, or name.'),
      limit: {
        type: 'number',
        description: 'Maximum result count. Defaults to 25.'
      }
    }),
    outputSchema: protocolOutputSchema('A bounded list of matching mission records.'),
    annotations: readOnly,
    _meta: widget('ui://overlord/mission-list.html')
  },
  {
    name: 'overlord_create_mission',
    title: 'Create Overlord mission',
    description:
      'Use this only when the user explicitly asks to create a mission in the specified project. This creates a draft mission; hosted MCP never chooses a project implicitly.',
    inputSchema: objectSchema(
      {
        projectId: stringProperty('Required Overlord project id, slug, or name.'),
        objective: stringProperty('Initial objective text.'),
        title: stringProperty('Optional mission title.'),
        resourceKey: stringProperty('Optional logical project resource key for the objective.')
      },
      ['projectId', 'objective']
    ),
    outputSchema: protocolOutputSchema(
      'The newly created draft mission and its initial objective.'
    ),
    annotations: writeAction
  },
  {
    name: 'overlord_load_mission_context',
    title: 'Load mission context',
    description:
      'Use this when the user wants to inspect one mission, its objectives, history, artifacts, or shared context.',
    inputSchema: objectSchema(
      {
        missionId: stringProperty('Mission UUID or workspace display id such as coo:150.'),
        executionTargetId: stringProperty(
          'Optional local execution target id for resolving sibling project resource paths.'
        )
      },
      ['missionId']
    ),
    outputSchema: protocolOutputSchema('Structured context for the requested mission.'),
    annotations: readOnly,
    _meta: widget('ui://overlord/objective-viewer.html')
  },
  {
    name: 'overlord_add_objectives',
    title: 'Add objectives',
    description:
      'Use this only when the user explicitly asks to append draft objectives to an existing mission.',
    inputSchema: objectSchema(
      {
        missionId: stringProperty('Mission UUID or workspace display id.'),
        objectives: {
          type: 'array',
          description: 'Objective objects with objective text and optional title/resourceKey.',
          items: objectSchema({
            objective: stringProperty('Objective text.'),
            title: stringProperty('Optional objective title.'),
            resourceKey: stringProperty('Optional logical project resource key.')
          })
        }
      },
      ['missionId', 'objectives']
    ),
    outputSchema: protocolOutputSchema('The mission with the appended draft objectives.'),
    annotations: writeAction
  },
  {
    name: 'overlord_attach_session',
    title: 'Attach to mission',
    description:
      'Use this only after the user asks the connected agent to begin work on a mission. It opens an MCP-hosted session for later updates and delivery.',
    inputSchema: objectSchema(
      {
        missionId: stringProperty('Mission UUID or workspace display id.'),
        agent: stringProperty('Agent identifier. Defaults to hosted-mcp.'),
        model: stringProperty('Optional model identifier.'),
        executionTargetId: stringProperty(
          'Optional local execution target id for resolving sibling project resource paths.'
        )
      },
      ['missionId']
    ),
    outputSchema: protocolOutputSchema(
      'Attached session context, including the session key required for lifecycle calls.'
    ),
    annotations: writeAction
  },
  {
    name: 'overlord_update_session',
    title: 'Update mission session',
    description:
      'Use this only to post the user-requested work update, alert, decision, or discussion summary to an attached mission session.',
    inputSchema: objectSchema(
      {
        missionId: stringProperty('Mission UUID or workspace display id.'),
        sessionKey: stringProperty('Session key returned by overlord_attach_session.'),
        summary: stringProperty('Update text.'),
        phase: stringProperty('Optional protocol phase.'),
        eventType: stringProperty('Optional event type. Defaults to update.')
      },
      ['missionId', 'sessionKey', 'summary']
    ),
    outputSchema: protocolOutputSchema('The recorded mission activity event.'),
    annotations: writeAction
  },
  {
    name: 'overlord_deliver_session',
    title: 'Deliver mission session',
    description:
      'Use this only when the user-requested mission work is complete. It delivers the attached session with an explicit summary and optional file-change rationales.',
    inputSchema: objectSchema(
      {
        missionId: stringProperty('Mission UUID or workspace display id.'),
        sessionKey: stringProperty('Session key returned by overlord_attach_session.'),
        summary: stringProperty('Delivery summary.'),
        noFileChanges: {
          type: 'boolean',
          description: 'Set true when the MCP run changed no files.'
        },
        changeRationales: {
          type: 'array',
          description: 'Explicit change rationale objects, if files were changed.'
        }
      },
      ['missionId', 'sessionKey', 'summary']
    ),
    outputSchema: protocolOutputSchema(
      'The completed delivery record and any recorded file changes.'
    ),
    annotations: writeAction,
    _meta: widget('ui://overlord/file-changes.html')
  }
];

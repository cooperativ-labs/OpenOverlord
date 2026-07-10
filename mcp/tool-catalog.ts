export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
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

export const hostedMcpToolDefinitions: ToolDefinition[] = [
  {
    name: 'overlord_resolve_project',
    title: 'Resolve Overlord project',
    description:
      'Resolve a project by id, slug, name, or linked repository directory metadata exposed to the MCP client.',
    inputSchema: objectSchema({
      projectId: stringProperty('Explicit Overlord project id, slug, or project name.'),
      directory: stringProperty(
        'Optional repository directory path when the MCP client can expose one with .overlord/project.json.'
      )
    }),
    annotations: { readOnlyHint: true }
  },
  {
    name: 'overlord_search_missions',
    title: 'Search Overlord missions',
    description: 'Search missions in the OAuth-bound workspace.',
    inputSchema: objectSchema({
      query: stringProperty('Search query text.'),
      status: stringProperty('Comma-separated status types, such as draft,execute,review.'),
      projectId: stringProperty('Optional project id, slug, or name.'),
      limit: {
        type: 'number',
        description: 'Maximum result count. Defaults to 25.'
      }
    }),
    annotations: { readOnlyHint: true }
  },
  {
    name: 'overlord_create_mission',
    title: 'Create Overlord mission',
    description:
      'Create a mission in an explicit project. Hosted MCP never chooses a default project implicitly.',
    inputSchema: objectSchema(
      {
        projectId: stringProperty('Required Overlord project id, slug, or name.'),
        objective: stringProperty('Initial objective text.'),
        title: stringProperty('Optional mission title.'),
        resourceKey: stringProperty('Optional logical project resource key for the objective.')
      },
      ['projectId', 'objective']
    )
  },
  {
    name: 'overlord_load_mission_context',
    title: 'Load mission context',
    description:
      'Load structured mission context, objectives, history, artifacts, and shared context.',
    inputSchema: objectSchema(
      {
        missionId: stringProperty('Mission UUID or workspace display id such as coo:150.'),
        executionTargetId: stringProperty(
          'Optional local execution target id for resolving sibling project resource paths.'
        )
      },
      ['missionId']
    ),
    annotations: { readOnlyHint: true }
  },
  {
    name: 'overlord_add_objectives',
    title: 'Add objectives',
    description: 'Append one or more draft objectives to an existing mission.',
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
    )
  },
  {
    name: 'overlord_attach_session',
    title: 'Attach to mission',
    description: 'Attach an MCP-hosted agent session to a mission before update/ask/deliver.',
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
    )
  },
  {
    name: 'overlord_update_session',
    title: 'Update mission session',
    description: 'Post an update, alert, decision, or discussion summary for an attached session.',
    inputSchema: objectSchema(
      {
        missionId: stringProperty('Mission UUID or workspace display id.'),
        sessionKey: stringProperty('Session key returned by overlord_attach_session.'),
        summary: stringProperty('Update text.'),
        phase: stringProperty('Optional protocol phase.'),
        eventType: stringProperty('Optional event type. Defaults to update.')
      },
      ['missionId', 'sessionKey', 'summary']
    )
  },
  {
    name: 'overlord_deliver_session',
    title: 'Deliver mission session',
    description:
      'Deliver an attached session with explicit summary and optional change rationales.',
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
    )
  }
];

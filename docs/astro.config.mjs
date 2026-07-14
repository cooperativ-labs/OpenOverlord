import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'The Docs',
      description: 'Guides for using Overlord to manage and coordinate AI coding agents.',
      favicon: '/favicon.ico',
      logo: {
        src: '../webapp/public/images/256.png',
        alt: 'Overlord'
      },
      customCss: [
        '@fontsource-variable/space-grotesk/index.css',
        '@fontsource/ibm-plex-mono/400.css',
        '@fontsource/ibm-plex-mono/500.css',
        './src/styles/overlord.css'
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/cooperativ-labs/Overlord'
        }
      ],
      sidebar: [
        {
          label: 'Get started',
          items: [
            { label: 'Welcome', slug: 'index' },
            { label: 'Core concepts', slug: 'core-concepts' },
            { label: 'Local or Cloud', slug: 'local-or-cloud' },
            { label: 'Set up Overlord', slug: 'getting-started' }
          ]
        },
        {
          label: 'Work with missions',
          items: [
            { label: 'Missions and objectives', slug: 'missions' },
            { label: 'Plan and track work', slug: 'planning-and-tracking' },
            { label: 'Missions and collaboration', slug: 'missions-and-collaboration' },
            { label: 'Context and artifacts', slug: 'context-and-artifacts' },
            { label: 'Review deliveries', slug: 'reviewing-work' },
            { label: 'Retries and blocked work', slug: 'retries-and-blocked-work' }
          ]
        },
        {
          label: 'Configure your workspace',
          items: [
            { label: 'Members and roles', slug: 'members-and-roles' },
            { label: 'Projects and resources', slug: 'projects' },
            { label: 'Execution targets', slug: 'execution-targets' },
            { label: 'Terminal and IDE preferences', slug: 'terminal-and-ide' },
            { label: 'Agents and connectors', slug: 'agents' }
          ]
        },
        {
          label: 'Use Overlord your way',
          items: [
            { label: 'Web app', slug: 'web-app' },
            { label: 'Desktop app', slug: 'desktop-app' },
            { label: 'CLI', slug: 'cli' },
            { label: 'MCP access', slug: 'mcp' }
          ]
        },
        {
          label: 'Integrations and automation',
          items: [
            { label: 'Integrations', slug: 'integrations' },
            { label: 'Webhooks', slug: 'webhooks' }
          ]
        },
        {
          label: 'Docs for agents',
          items: [
            { label: 'Overview', slug: 'docs-for-agents' },
            { label: 'Onboarding a new user', slug: 'docs-for-agents/onboarding' },
            { label: 'The agent protocol', slug: 'docs-for-agents/agent-protocol' },
            { label: 'Authentication & troubleshooting', slug: 'docs-for-agents/authentication' },
            { label: 'Architecture', slug: 'docs-for-agents/architecture' },
            { label: 'MCP access', slug: 'docs-for-agents/mcp' },
            { label: 'Webhooks', slug: 'docs-for-agents/webhooks' }
          ]
        },
        {
          label: 'Security and privacy',
          items: [
            { label: 'Authentication and permissions', slug: 'authentication-and-permissions' },
            { label: 'Data boundaries', slug: 'data-boundaries' },
            { label: 'Credentials and providers', slug: 'credentials' }
          ]
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI reference', slug: 'cli' },
            { label: 'Troubleshooting', slug: 'troubleshooting' },
            { label: 'Glossary', slug: 'glossary' },
            { label: 'Release notes and status', slug: 'release-notes' }
          ]
        }
      ]
    })
  ]
});

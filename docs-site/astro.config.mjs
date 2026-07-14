import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'Overlord Docs',
      description: 'Guides for using Overlord to coordinate AI coding agents.',
      favicon: '../webapp/public/images/256.png',
      logo: {
        src: '../webapp/public/images/256.png',
        alt: 'Overlord',
      },
      customCss: [
        '@fontsource-variable/space-grotesk/index.css',
        '@fontsource/ibm-plex-mono/400.css',
        '@fontsource/ibm-plex-mono/500.css',
        './src/styles/overlord.css',
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/cooperativ-labs/Overlord',
        },
      ],
      sidebar: [
        {
          label: 'Get started',
          items: [
            { label: 'Welcome', slug: 'index' },
            { label: 'Set up Overlord', slug: 'getting-started' },
          ],
        },
        {
          label: 'Work with missions',
          items: [
            { label: 'Missions and objectives', slug: 'missions' },
            { label: 'Review deliveries', slug: 'reviewing-work' },
          ],
        },
        {
          label: 'Configure your workspace',
          items: [
            { label: 'Projects and resources', slug: 'projects' },
            { label: 'Agents and connectors', slug: 'agents' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI reference', slug: 'cli' },
            { label: 'Troubleshooting', slug: 'troubleshooting' },
          ],
        },
      ],
    }),
  ],
});

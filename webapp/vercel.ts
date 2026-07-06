const backendUrl = process.env.OVERLORD_BACKEND_URL?.trim().replace(/\/+$/, '') ?? '';

const backendRewrites = backendUrl
  ? [
      { source: '/mcp', destination: `${backendUrl}/mcp` },
      { source: '/oauth/authorize', destination: `${backendUrl}/oauth/authorize` },
      { source: '/oauth/register', destination: `${backendUrl}/oauth/register` },
      { source: '/oauth/token', destination: `${backendUrl}/oauth/token` },
      { source: '/oauth/revoke', destination: `${backendUrl}/oauth/revoke` }
    ]
  : [];

export default {
  $schema: 'https://openapi.vercel.sh/vercel.json',
  framework: null,
  installCommand: 'cd .. && yarn install',
  buildCommand:
    'node scripts/write-runtime-config.mjs && cd .. && yarn contract:build:prod && yarn automations:build:prod && yarn webapp:build:prod',
  outputDirectory: 'dist',
  regions: ['fra1'],
  headers: [
    // The generated .well-known OAuth discovery documents are extensionless
    // static files, which Vercel would otherwise serve as
    // application/octet-stream. Force application/json so strict OAuth/MCP
    // clients accept them during discovery.
    {
      source: '/.well-known/oauth-authorization-server',
      headers: [{ key: 'Content-Type', value: 'application/json; charset=utf-8' }]
    },
    {
      source: '/.well-known/oauth-protected-resource/mcp',
      headers: [{ key: 'Content-Type', value: 'application/json; charset=utf-8' }]
    },
    ...(backendUrl
      ? [
          {
            source: '/mcp',
            headers: [{ key: 'x-vercel-enable-rewrite-caching', value: '0' }]
          },
          {
            source: '/oauth/:path*',
            headers: [{ key: 'x-vercel-enable-rewrite-caching', value: '0' }]
          }
        ]
      : [])
  ],
  rewrites: [...backendRewrites, { source: '/(.*)', destination: '/index.html' }]
};

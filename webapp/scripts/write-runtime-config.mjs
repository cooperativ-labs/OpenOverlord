import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendUrl = process.env.OVERLORD_BACKEND_URL?.trim() ?? '';
const webappUrl = normalizePublicUrl(
  process.env.OVERLORD_WEBAPP_PUBLIC_URL?.trim() ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ||
    process.env.VERCEL_URL?.trim() ||
    ''
);

if (!backendUrl) {
  console.warn(
    'OVERLORD_BACKEND_URL is unset; the hosted web shell will fall back to same-origin API calls.'
  );
}

const outDir = path.join(here, '..', 'public');
mkdirSync(outDir, { recursive: true });

const payload = JSON.stringify({ apiBaseUrl: backendUrl });
writeFileSync(
  path.join(outDir, 'runtime-config.js'),
  `window.__OVERLORD_RUNTIME__ = ${payload};\n`,
  'utf8'
);

writeWellKnownMetadata();

console.log(`Wrote runtime config with apiBaseUrl=${backendUrl || '(same-origin)'}`);

function normalizePublicUrl(value) {
  if (!value) return '';
  const withScheme = /^https?:\/\//.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, '');
}

function oauthMetadata() {
  return {
    issuer: webappUrl,
    authorization_endpoint: `${webappUrl}/oauth/approve`,
    token_endpoint: `${webappUrl}/oauth/token`,
    registration_endpoint: `${webappUrl}/oauth/register`,
    revocation_endpoint: `${webappUrl}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [
      'overlord.workspace.read',
      'overlord.mission.read',
      'overlord.mission.write',
      'overlord.session.write'
    ]
  };
}

function protectedResourceMetadata() {
  return {
    resource: `${webappUrl}/mcp`,
    authorization_servers: [`${webappUrl}/.well-known/oauth-authorization-server`],
    bearer_methods_supported: ['header'],
    resource_documentation: `${webappUrl}/mcp`,
    scopes_supported: [
      'overlord.workspace.read',
      'overlord.mission.read',
      'overlord.mission.write',
      'overlord.session.write'
    ]
  };
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeWellKnownMetadata() {
  const wellKnownDir = path.join(outDir, '.well-known');
  rmSync(wellKnownDir, { recursive: true, force: true });
  if (!webappUrl) {
    console.warn(
      'OVERLORD_WEBAPP_PUBLIC_URL/VERCEL_URL is unset; hosted-web OAuth discovery files were not generated.'
    );
    return;
  }

  writeJson(path.join(wellKnownDir, 'oauth-authorization-server'), oauthMetadata());
  writeJson(
    path.join(wellKnownDir, 'oauth-protected-resource', 'mcp'),
    protectedResourceMetadata()
  );
  console.log(`Wrote hosted-web OAuth discovery metadata for ${webappUrl}`);
}

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const roots = ['backend', 'packages'];
const ignored =
  /(?:^|\/)(?:dist-server|test|tests)(?:\/|$)|\.test\.[cm]?[jt]sx?$|secondary-workspace-fixture\.ts$/;

// Each surviving ambient read must be an intentional edge/default operation.
// Entries are keyed by file and enclosing function so line movement is harmless.
const allow = (file, scope, ...expressions) =>
  expressions.map(expression => ({ file, scope, expression }));

const allowedFiles = new Set([
  // Accessor definitions, request-context binding and explicit active-edge helpers.
  'backend/db.ts'
]);

const allowed = [
  ...allow('backend/auth.ts', 'requireAuthenticatedSession', 'getActiveWorkspaceIdOrNull'),
  ...allow(
    'backend/execution/execution-target-migration.ts',
    'getExecutionTargetMigrationDiagnostics',
    'getActiveWorkspaceId'
  ),
  ...allow('backend/execution/launch.ts', 'resolveCatalogWorkspaceId', 'WORKSPACE.id'),

  // Workspace-level integration connect/disconnect and settings reads.
  ...allow('backend/ext/everhour/service.ts', 'readEverhourConnection', 'WORKSPACE.id'),
  ...allow('backend/ext/everhour/service.ts', 'writeEverhourConnection', 'WORKSPACE.id'),
  ...allow('backend/ext/everhour/service.ts', 'clearEverhourConnection', 'WORKSPACE.id'),
  ...allow('backend/ext/github/service.ts', 'readInstallation', 'WORKSPACE.id'),
  ...allow('backend/ext/github/service.ts', 'requireInstallationToken', 'WORKSPACE.id'),
  ...allow('backend/ext/github/service.ts', 'beginGitHubInstall', 'WORKSPACE.id'),
  ...allow('backend/ext/github/service.ts', 'completeGitHubInstall', 'WORKSPACE.id'),
  ...allow('backend/ext/github/service.ts', 'disconnectGitHub', 'WORKSPACE.id'),

  // Request/transport edges and active landing/configuration surfaces.
  ...allow('backend/http/meta.ts', 'buildMeta', 'getActiveWorkspaceIdOrNull'),
  ...allow('backend/index.ts', 'handle', 'getActiveWorkspaceId'),
  ...allow('backend/index.ts', 'GET /api/workspaces', 'getActiveWorkspaceId'),
  ...allow('backend/index.ts', 'POST /api/workspaces', 'getActiveWorkspaceId'),
  ...allow('backend/index.ts', 'POST /api/uploads/:bucketKey', 'getActiveWorkspaceId'),
  ...allow('backend/index.ts', 'GET /sync/changes', 'getActiveWorkspaceId'),
  ...allow('backend/index.ts', 'streamRealtime', 'getActiveWorkspaceId'),
  ...allow(
    'backend/index.ts',
    'start',
    'getActiveWorkspaceIdOrNull',
    'WORKSPACE.name',
    'WORKSPACE.slug'
  ),
  ...allow('backend/oauth.ts', 'handleOAuthApprove', 'getActiveWorkspaceId'),
  ...allow('backend/organizations.ts', 'getActiveOrganizationIdOrNull', 'getActiveWorkspaceIdOrNull'),
  ...allow('backend/protocol.ts', 'buildContext', 'WORKSPACE.id', 'WORKSPACE.slug', 'WORKSPACE.name'),
  ...allow('backend/rbac.ts', 'requireMissionPermission', 'getActiveWorkspaceId'),

  // Active-workspace settings, display metadata and create-with-no-parent defaults.
  ...allow('backend/repository.ts', 'listWorkspaceStatuses', 'getActiveWorkspaceId'),
  ...allow('backend/repository.ts', 'resolveStatusWorkspaceId', 'getActiveWorkspaceId'),
  ...allow('backend/repository.ts', 'createProject', 'getActiveWorkspaceId'),
  ...allow('backend/repository.ts', 'toProfileDto', 'getActiveWorkspaceId'),
  ...allow('backend/repository.ts', 'updateProfile', 'getActiveWorkspaceId'),
  ...allow('backend/repository.ts', 'loadOperatorIdentity', 'getActiveWorkspaceId'),
  ...allow('backend/repository.ts', 'createUserToken', 'getActiveWorkspaceId'),
  ...allow('backend/storage.ts', 'uploadUserImage', 'WORKSPACE.id'),
  ...allow('backend/storage.ts', 'uploadWorkspaceImage', 'WORKSPACE.id'),
  ...allow('backend/storage.ts', 'resolveStoredObject', 'WORKSPACE.id'),
  ...allow('backend/webhooks.ts', 'resolveWebhookCreateScope', 'getActiveWorkspaceId'),
  ...allow('backend/webhooks.ts', 'listWebhookSubscriptions', 'getActiveWorkspaceId'),
  ...allow('backend/workspaces.ts', 'toWorkspaceDto', 'getActiveWorkspaceIdOrNull'),
  ...allow('backend/workspaces.ts', 'updateWorkspace', 'getActiveWorkspaceIdOrNull'),
  ...allow('backend/workspaces.ts', 'deleteWorkspace', 'getActiveWorkspaceIdOrNull')
];

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (ignored.test(file)) return [];
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.[cm]?[jt]sx?$/.test(file) ? [file] : [];
  });
}

function functionName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText();
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    if (ts.isFunctionLike(current)) {
      for (let parent = current.parent; parent; parent = parent.parent) {
        if (
          ts.isCallExpression(parent) &&
          ts.isPropertyAccessExpression(parent.expression) &&
          ts.isIdentifier(parent.expression.expression) &&
          ['app', 'router'].includes(parent.expression.expression.text) &&
          ['get', 'post', 'put', 'patch', 'delete'].includes(parent.expression.name.text) &&
          ts.isStringLiteral(parent.arguments[0])
        ) {
          return `${parent.expression.name.text.toUpperCase()} ${parent.arguments[0].text}`;
        }
      }
    }
  }
  return '<module>';
}

function ambientExpression(node) {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ['getActiveWorkspace', 'getActiveWorkspaceId', 'getActiveWorkspaceIdOrNull'].includes(
      node.expression.text
    )
  ) {
    return node.expression.text;
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'WORKSPACE' &&
    ['id', 'slug', 'name', 'kind'].includes(node.name.text)
  ) {
    return `WORKSPACE.${node.name.text}`;
  }
  return null;
}

const violations = [];
for (const file of roots.flatMap(sourceFiles)) {
  const source = readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const visit = node => {
    const expression = ambientExpression(node);
    if (expression) {
      const scope = functionName(node);
      const approved = allowedFiles.has(file) || allowed.some(
        entry => entry.file === file && entry.scope === scope && entry.expression === expression
      );
      if (!approved) {
        const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
        violations.push(`${file}:${line + 1} ${scope} uses ${expression}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

if (violations.length > 0) {
  console.error(
    'Unapproved ambient workspace reads:\n' + violations.map(item => `- ${item}`).join('\n')
  );
  process.exitCode = 1;
} else {
  process.stdout.write('Workspace scoping check passed.\n');
}

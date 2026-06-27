import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveRepoPath } from './config.js';
import { CliError } from './errors.js';

/** Marker in adapter skill templates where connector core body is interpolated. */
export const CONNECTOR_CORE_MARKER = '<!-- @connector-core -->';

export const CONNECTOR_CORE_SKILL_RELATIVE_PATH = 'skills/overlord-mission/SKILL.md';
export const CONNECTOR_CORE_REFERENCE_PREFIX = 'skills/overlord-mission/reference/';

/**
 * Locate `connectors/core/overlord-mission`. The connectors tree is not bundled
 * into the published CLI package, so resolve it in priority order: an explicit
 * `OVERLORD_CONNECTORS_DIR` sibling `core/overlord-mission`, the nearest
 * checkout walking up from cwd, then the package-relative fallback.
 */
export function connectorCoreRoot(): string {
  const override = process.env.OVERLORD_CONNECTORS_DIR;
  if (override) {
    const candidate = path.join(path.dirname(override), 'core', 'overlord-mission');
    if (existsSync(candidate)) return candidate;
  }

  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, 'connectors', 'core', 'overlord-mission');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return resolveRepoPath('connectors/core/overlord-mission');
}

export function isConnectorCoreSkillPath(relativePath: string): boolean {
  return relativePath === CONNECTOR_CORE_SKILL_RELATIVE_PATH;
}

export function isConnectorCoreReferencePath(relativePath: string): boolean {
  return (
    relativePath.startsWith(CONNECTOR_CORE_REFERENCE_PREFIX) &&
    relativePath.endsWith('.md') &&
    !relativePath.includes('..')
  );
}

export function stripMarkdownFrontmatter(text: string): string {
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return text;
  return text.slice(end + 5);
}

export function readConnectorCoreSkillBody(coreRoot = connectorCoreRoot()): string {
  const coreSkillPath = path.join(coreRoot, 'SKILL.md');
  if (!existsSync(coreSkillPath)) {
    throw new CliError({
      message: `Connector core skill missing at ${coreSkillPath}.`
    });
  }
  return stripMarkdownFrontmatter(readFileSync(coreSkillPath, 'utf8')).trim();
}

export function renderConnectorSkill({
  adapterTemplate,
  coreRoot = connectorCoreRoot()
}: {
  adapterTemplate: string;
  coreRoot?: string;
}): string {
  if (!adapterTemplate.includes(CONNECTOR_CORE_MARKER)) {
    throw new CliError({
      message:
        `Adapter skill template is missing ${CONNECTOR_CORE_MARKER}. ` +
        `Add the marker where connector core content should be interpolated.`
    });
  }

  const coreBody = readConnectorCoreSkillBody(coreRoot);
  const rendered = adapterTemplate.replace(CONNECTOR_CORE_MARKER, coreBody).trimEnd();
  return `${rendered}\n`;
}

export function readConnectorCoreReference({
  relativePath,
  coreRoot = connectorCoreRoot()
}: {
  relativePath: string;
  coreRoot?: string;
}): Buffer {
  if (!isConnectorCoreReferencePath(relativePath)) {
    throw new CliError({
      message: `Not a connector core reference path: ${relativePath}`
    });
  }

  const referencePath = path.join(coreRoot, 'reference', path.basename(relativePath));
  if (!existsSync(referencePath)) {
    throw new CliError({
      message: `Connector core reference missing at ${referencePath}.`
    });
  }
  return readFileSync(referencePath);
}

export function managedFileSourceExists({
  sourceDir,
  relativePath,
  coreRoot = connectorCoreRoot()
}: {
  sourceDir: string;
  relativePath: string;
  coreRoot?: string;
}): boolean {
  if (isConnectorCoreReferencePath(relativePath)) {
    return existsSync(path.join(coreRoot, 'reference', path.basename(relativePath)));
  }
  return existsSync(path.join(sourceDir, relativePath));
}

export function resolveManagedFileContents({
  sourceDir,
  relativePath,
  coreRoot = connectorCoreRoot()
}: {
  sourceDir: string;
  relativePath: string;
  coreRoot?: string;
}): Buffer {
  if (isConnectorCoreReferencePath(relativePath)) {
    return readConnectorCoreReference({ relativePath, coreRoot });
  }

  if (isConnectorCoreSkillPath(relativePath)) {
    const templatePath = path.join(sourceDir, relativePath);
    if (!existsSync(templatePath)) {
      throw new CliError({
        message: `Adapter skill template missing at ${templatePath}.`
      });
    }
    const rendered = renderConnectorSkill({
      adapterTemplate: readFileSync(templatePath, 'utf8'),
      coreRoot
    });
    return Buffer.from(rendered, 'utf8');
  }

  const sourcePath = path.join(sourceDir, relativePath);
  if (!existsSync(sourcePath)) {
    throw new CliError({
      message: `Declared managed file missing from connector source: ${relativePath}`
    });
  }
  return readFileSync(sourcePath);
}

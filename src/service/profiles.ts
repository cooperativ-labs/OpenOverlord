import type { OverlordDatabase } from '@overlord/database';

type ProfileMetadata = {
  avatarUrl?: string;
  agentInstructions?: string;
};

function parseProfileMetadata(metadataJson: string): ProfileMetadata {
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as ProfileMetadata;
  } catch {
    return {};
  }
}

export function avatarUrlFromProfileMetadata(metadataJson: string): string | null {
  const avatarUrl = parseProfileMetadata(metadataJson).avatarUrl;
  return typeof avatarUrl === 'string' && avatarUrl.trim() ? avatarUrl : null;
}

export function agentInstructionsFromProfileMetadata(metadataJson: string): string | null {
  const agentInstructions = parseProfileMetadata(metadataJson).agentInstructions;
  return typeof agentInstructions === 'string' && agentInstructions.trim()
    ? agentInstructions.trim()
    : null;
}

export function mergeProfileMetadataJson({
  metadataJson,
  avatarUrl,
  agentInstructions
}: {
  metadataJson: string;
  avatarUrl?: string | null;
  agentInstructions?: string | null;
}): string {
  const parsed = { ...parseProfileMetadata(metadataJson) };

  if (avatarUrl !== undefined) {
    if (avatarUrl) parsed.avatarUrl = avatarUrl;
    else delete parsed.avatarUrl;
  }

  if (agentInstructions !== undefined) {
    const trimmed = agentInstructions?.trim() ?? '';
    if (trimmed) parsed.agentInstructions = trimmed;
    else delete parsed.agentInstructions;
  }

  return JSON.stringify(parsed);
}

export function loadAgentInstructionsForWorkspaceUser({
  db,
  workspaceUserId
}: {
  db: OverlordDatabase;
  workspaceUserId: string | null;
}): string | null {
  if (!workspaceUserId) return null;

  const row = db
    .prepare(
      `SELECT p.metadata_json
         FROM profiles p
         JOIN workspace_users wu ON wu.profile_id = p.id
        WHERE wu.id = ? AND p.deleted_at IS NULL`
    )
    .get(workspaceUserId) as { metadata_json: string } | undefined;

  if (!row) return null;
  return agentInstructionsFromProfileMetadata(row.metadata_json);
}

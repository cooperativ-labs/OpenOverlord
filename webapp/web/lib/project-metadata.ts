import type { ProjectResourceDto } from '../../shared/contract.ts';

export async function writeLocalProjectMetadata({
  directoryPath,
  projectId,
  resource
}: {
  directoryPath: string;
  projectId: string;
  resource: ProjectResourceDto;
}): Promise<void> {
  const writeProjectMetadata = window.overlord?.writeProjectMetadata;
  if (!writeProjectMetadata) return;
  await writeProjectMetadata({
    directoryPath,
    projectId,
    resourceId: resource.id,
    executionTargetId: resource.executionTargetId,
    isPrimary: resource.isPrimary
  });
}

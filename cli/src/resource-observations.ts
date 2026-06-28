import type { ProjectResourceDto } from '@overlord/contract';
import { InProcessProvider } from '@overlord/core/service/local-target/in-process-provider';

type BackendClient = {
  get: <T>(path: string) => Promise<T>;
  post: <T>(args: { path: string; body?: unknown }) => Promise<T>;
};

function resourcesForTarget({
  resources,
  executionTargetId
}: {
  resources: ProjectResourceDto[];
  executionTargetId: string;
}): ProjectResourceDto[] {
  return resources.filter(
    resource =>
      resource.type === 'local_directory' &&
      resource.status !== 'archived' &&
      (resource.executionTargetId === executionTargetId || resource.executionTargetId === null)
  );
}

/** Observe project resources on this machine and write results to the control plane. */
export async function reportRunnerResourceObservations({
  backend,
  projectId,
  executionTargetId
}: {
  backend: BackendClient;
  projectId: string;
  executionTargetId: string;
}): Promise<number> {
  const resources = await backend.get<ProjectResourceDto[]>(
    `/api/projects/${encodeURIComponent(projectId)}/resources`
  );
  const scoped = resourcesForTarget({ resources, executionTargetId });
  if (scoped.length === 0) return 0;

  const provider = new InProcessProvider({
    executionTargetId,
    deviceLabel: null,
    transport: 'in_process'
  });

  const observations = [];
  for (const resource of scoped) {
    const result = await provider.observeResource({
      resourceId: resource.id,
      path: resource.path
    });
    if (!result.ok) continue;
    observations.push({
      resourceId: resource.id,
      state: result.value.state,
      gitRoot: result.value.gitRoot ?? null,
      branch: result.value.branch ?? null,
      commit: result.value.commit ?? null,
      observedAt: result.value.observedAt
    });
  }

  if (observations.length === 0) return 0;

  const response = await backend.post<{ recorded: number }>({
    path: `/api/execution-targets/${encodeURIComponent(executionTargetId)}/observations`,
    body: { observations }
  });
  return response.recorded ?? observations.length;
}

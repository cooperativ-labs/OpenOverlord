import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import type { ResourceObservation } from '../../../packages/core/service/local-target/types.ts';
import type {
  ProjectResourceDto,
  RecordTargetResourceObservationsBody
} from '../../shared/contract.ts';

import { api } from './api.ts';
import { invokeLocalTarget, isLocalTargetCapabilityAvailable } from './local-target-client.ts';
import { keys } from './queries.ts';

const OBSERVATION_INTERVAL_MS = 60_000;

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

export async function reportResourceObservations({
  executionTargetId,
  resources
}: {
  executionTargetId: string;
  resources: ProjectResourceDto[];
}): Promise<number> {
  if (!(await isLocalTargetCapabilityAvailable())) return 0;

  const scoped = resourcesForTarget({ resources, executionTargetId });
  if (scoped.length === 0) return 0;

  const observations: RecordTargetResourceObservationsBody['observations'] = [];
  for (const resource of scoped) {
    const result = await invokeLocalTarget<ResourceObservation>({
      capability: 'observeResource',
      input: { resourceId: resource.id, path: resource.path }
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

  const response = await api.recordTargetResourceObservations(executionTargetId, {
    observations
  });
  return response.recorded;
}

/** Observe linked resources on the acting device and write results to the control plane. */
export function useResourceObservationReporter({
  projectId,
  executionTargetId,
  resources,
  enabled
}: {
  projectId: string;
  executionTargetId: string | null;
  resources: ProjectResourceDto[];
  enabled: boolean;
}): void {
  const queryClient = useQueryClient();
  const inFlight = useRef(false);

  // Hold the latest resources in a ref so the polling effect can read them without
  // listing `resources` as a dependency. Without this, invalidating the
  // projectResources query on a successful observation produces a new `resources`
  // reference, which would re-run the effect and immediately fire another
  // observation — a feedback loop that bypasses OBSERVATION_INTERVAL_MS and hammers
  // the /observations endpoint multiple times per second.
  const resourcesRef = useRef(resources);
  resourcesRef.current = resources;

  const hasResources = resources.length > 0;

  useEffect(() => {
    if (!enabled || !executionTargetId || !hasResources) return;

    const run = async (): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const recorded = await reportResourceObservations({
          executionTargetId,
          resources: resourcesRef.current
        });
        if (recorded > 0) {
          await queryClient.invalidateQueries({ queryKey: keys.projectResources(projectId) });
        }
      } finally {
        inFlight.current = false;
      }
    };

    void run();
    const interval = window.setInterval(() => {
      void run();
    }, OBSERVATION_INTERVAL_MS);
    const onFocus = (): void => {
      void run();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, executionTargetId, projectId, queryClient, hasResources]);
}

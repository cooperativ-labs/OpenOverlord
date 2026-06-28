export type DoctorCheck = {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
};

export type ExecutionTargetMigrationDiagnostics = {
  hostedBackend: boolean;
  backendHostFingerprint: string;
  staleBackendHostTargets: Array<{
    executionTargetId: string;
    label: string;
    deviceLabel: string | null;
    deviceFingerprint: string;
  }>;
  staleQueuedExecutionRequestCount: number;
};

export function buildExecutionTargetMigrationDoctorCheck({
  diagnostics
}: {
  diagnostics: ExecutionTargetMigrationDiagnostics;
}): DoctorCheck | null {
  if (!diagnostics.hostedBackend) return null;

  const staleCount = diagnostics.staleBackendHostTargets.length;
  if (staleCount === 0 && diagnostics.staleQueuedExecutionRequestCount === 0) {
    return {
      name: 'execution-target-migration',
      ok: true,
      required: false,
      detail: 'No execution targets are stamped with the hosted backend host fingerprint.'
    };
  }

  const targetSummary =
    staleCount === 1
      ? `1 execution target (${diagnostics.staleBackendHostTargets[0]!.label})`
      : `${staleCount} execution targets`;

  const queueSummary =
    diagnostics.staleQueuedExecutionRequestCount > 0
      ? ` ${diagnostics.staleQueuedExecutionRequestCount} queued execution request(s) still reference stale target(s).`
      : '';

  return {
    name: 'execution-target-migration',
    ok: false,
    required: false,
    detail:
      `${targetSummary} use the hosted backend/container hostname fingerprint and cannot run checkout-local work.` +
      queueSummary +
      ' In the web app, open Project Settings → Resources, re-select your client device as the execution target, re-link the primary resource to that target, and clear or re-queue stale execution requests. See docs/upgrading-client-checkout-bridge.md.'
  };
}

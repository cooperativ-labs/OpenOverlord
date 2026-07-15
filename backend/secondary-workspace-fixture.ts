import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';

/**
 * The reusable A/B structural fixture for coo:331 (resource-derived workspace
 * scoping). It sets up the one scenario that catches the entire bug class:
 *
 *   a **resource lives in workspace B** while the caller's **active workspace is A**,
 *   both under the one bootstrapped profile (an ADMIN of both).
 *
 * Every workspace-scoped operation must resolve against the *resource's* workspace
 * (B), not the ambient/active one (A). The origin bug (Phase 0) was agent launch
 * config being saved in A but read by `launchObjective` from the objective's own
 * workspace B, so a mission run from a secondary workspace launched with an empty
 * config. As Phase 2 converts each remaining ambient read, a test built on this
 * fixture asserts the converted endpoint reads/writes against B — so the bug class
 * is caught at the door for every newly-converted endpoint.
 *
 * `setupSecondaryWorkspaceFixture` mirrors the inline setup the other suites in
 * `mission-secondary-workspace.test.ts` repeat by hand: bootstrap A, create B,
 * switch active back to A, then create a project (with a primary resource that
 * provisions B's acting-device execution target), a mission, and an objective —
 * all in B. Callers then exercise a scoped operation and assert it lands in B.
 */
export interface SecondaryWorkspaceFixture {
  /** Id of the bootstrapped workspace that stays *active* for the whole test. */
  workspaceAId: string;
  /** The secondary (non-active) workspace B that owns every resource below. */
  secondary: { id: string; slug: string; name: string };
  /** A project in workspace B, with a primary resource + acting-device target. */
  project: { id: string; workspaceId: string };
  /** A mission in workspace B. `mission.workspaceId === secondary.id`. */
  mission: {
    id: string;
    workspaceId: string;
    displayId: string;
    objectives: Array<{ id: string }>;
  };
  /** The mission's first objective (lives in workspace B). */
  objectiveId: string;
}

export async function setupSecondaryWorkspaceFixture(options?: {
  /** Label prefix for the created workspace/project, to disambiguate suites. */
  namePrefix?: string;
}): Promise<SecondaryWorkspaceFixture> {
  const prefix = options?.namePrefix ?? 'Secondary Fixture';
  const dir = mkdtempSync(path.join('/tmp', 'ovld-secondary-fixture-'));

  const { bootstrapIntegrationTestDb, DEFAULT_TEST_ORGANIZATION_ID } =
    await import('./test-helpers.ts');
  const { WORKSPACE } = await bootstrapIntegrationTestDb({
    sqlitePath: path.join(dir, 'Overlord.sqlite')
  });
  // `WORKSPACE` is a live getter over the active workspace (see `backend/db.ts`),
  // and `createWorkspace` below re-points it — capture A's id as a string now.
  const workspaceAId = WORKSPACE.id;

  const { setActiveWorkspace } = await import('./db.ts');
  const { createWorkspace } = await import('./workspaces.ts');
  const { createProject, createProjectResource, createMission } = await import('./repository.ts');

  // A second workspace in the same org. The bootstrapped operator (org admin,
  // ADMIN of the only pre-existing workspace) is auto-granted ADMIN here too.
  // `createWorkspace` activates the workspace it just created, so switch back to
  // A afterward: every operation a caller runs then executes with A active while
  // the resources below live in the non-active workspace B — the reported bug.
  const secondary = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: `${prefix} Workspace`
  });
  assert.notEqual(secondary.id, workspaceAId);
  await setActiveWorkspace(workspaceAId);

  const project = await createProject({ name: `${prefix} Project`, workspaceId: secondary.id });
  assert.equal(project.workspaceId, secondary.id);

  // A primary resource with `executionTargetId: null` provisions B's implicit
  // acting-device execution target, so launch/target resolution has a real
  // execution target to land preferences on and to queue against.
  await createProjectResource(project.id, {
    directoryPath: mkdtempSync(path.join('/tmp', 'ovld-secondary-fixture-resource-')),
    executionTargetId: null,
    isPrimary: true
  });

  const mission = await createMission({
    projectId: project.id,
    firstObjective: 'Exercise a workspace-scoped operation from a secondary workspace'
  });
  // Mission creation must stamp the project's workspace, not the active one.
  assert.equal(mission.workspaceId, secondary.id);

  return {
    workspaceAId,
    secondary,
    project,
    mission,
    objectiveId: mission.objectives[0]!.id
  };
}

/**
 * The reusable invariant every converted endpoint must satisfy: a value written
 * while *scoped to the resource's workspace B* is visible when read scoped to B,
 * and is **not** visible when read scoped to the active workspace A. This is the
 * structural signature of resource-derived scoping — a write that leaks into A,
 * or a read that resolves A instead of B, fails one of the two assertions.
 *
 * Pass reads/writes already bound to a workspace id, plus an `extract` that pulls
 * the comparable value out of the read result. `equals`/`present` default to a
 * deep-equality comparison and a truthiness check; override them for values whose
 * "absent in A" state is not simply falsy.
 */
export async function assertScopedToResourceWorkspace<TRead>(params: {
  fixture: SecondaryWorkspaceFixture;
  /** Perform the write against the given workspace id (call it with B's id). */
  write: (workspaceId: string) => Promise<unknown>;
  /** Read the value back scoped to the given workspace id. */
  read: (workspaceId: string) => Promise<TRead>;
  /** Pull the comparable value out of a read result. */
  extract: (read: TRead) => unknown;
  /** The value the write is expected to have set (compared against B's read). */
  expected: unknown;
  /** Equality used for the "B sees it" assertion. Defaults to deepEqual. */
  equals?: (actual: unknown, expected: unknown) => boolean;
  /** Whether A's read shows the written value. Defaults to truthiness. */
  present?: (actual: unknown) => boolean;
  message?: string;
}): Promise<void> {
  const {
    fixture,
    write,
    read,
    extract,
    expected,
    equals = (a, b) => {
      try {
        assert.deepEqual(a, b);
        return true;
      } catch {
        return false;
      }
    },
    present = value => Boolean(value),
    message = 'operation'
  } = params;

  await write(fixture.secondary.id);

  const fromB = extract(await read(fixture.secondary.id));
  assert.ok(
    equals(fromB, expected),
    `${message}: reading scoped to the resource's workspace B must return the written value, got ${JSON.stringify(fromB)}`
  );

  const fromA = extract(await read(fixture.workspaceAId));
  assert.ok(
    !present(fromA),
    `${message}: the write must not leak into the active workspace A, got ${JSON.stringify(fromA)}`
  );
}

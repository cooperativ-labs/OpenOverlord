import type { SqlDialect } from '@overlord/database';
import os from 'node:os';
import path from 'node:path';

import {
  invokeLocalTargetCapability,
  type LocalTargetBridgeCall
} from '../packages/core/service/local-target/desktop-bridge.ts';
import { InProcessProvider } from '../packages/core/service/local-target/in-process-provider.ts';
import { isCoLocatedBackend } from '../packages/core/service/local-target/resource-status.ts';
import { fail } from '../packages/core/service/local-target/result.ts';
import type { CapabilityResult } from '../packages/core/service/local-target/types.ts';

import { isDevInProcessLocalTargetEnabled } from './local-target-capability.ts';

function resolveServerWorktreeRoot(): string {
  const override = process.env.OVERLORD_WORKTREE_ROOT?.trim();
  if (override) return path.resolve(override);
  const home = process.env.OVLD_HOME?.trim() || process.env.OVERLORD_HOME?.trim();
  return path.join(home ? path.resolve(home) : path.join(os.homedir(), '.ovld'), 'worktrees');
}

function withServerDefaults(call: LocalTargetBridgeCall): LocalTargetBridgeCall {
  if (call.capability !== 'listWorktrees') return call;
  const worktreeRoot = call.input.worktreeRoot?.trim()
    ? call.input.worktreeRoot
    : resolveServerWorktreeRoot();
  return { ...call, input: { ...call.input, worktreeRoot } };
}

function backendTargetMetadata() {
  return {
    executionTargetId: null,
    deviceLabel: null,
    transport: 'in_process' as const
  };
}

/**
 * Dev-only in-process local-target proxy for browser + loopback SQLite.
 * Hosted Postgres backends reject these calls with LOCAL_TARGET_REQUIRED.
 */
export async function invokeLocalTargetOnServer({
  dialect,
  call
}: {
  dialect: SqlDialect;
  call: LocalTargetBridgeCall;
}): Promise<CapabilityResult<unknown>> {
  if (!isCoLocatedBackend(dialect) || !isDevInProcessLocalTargetEnabled()) {
    return fail(
      backendTargetMetadata(),
      'LOCAL_TARGET_REQUIRED',
      'Checkout-local capabilities must run on a local execution target (Overlord Desktop or the dev invoke proxy).'
    );
  }

  const provider = new InProcessProvider(backendTargetMetadata());
  return invokeLocalTargetCapability({ provider, call: withServerDefaults(call) });
}

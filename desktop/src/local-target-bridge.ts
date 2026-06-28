import { hostname, homedir } from 'node:os';
import path from 'node:path';

import {
  invokeLocalTargetCapability,
  type LocalTargetBridgeCall
} from '../../packages/core/service/local-target/desktop-bridge.ts';
import { InProcessProvider } from '../../packages/core/service/local-target/in-process-provider.ts';
import { fail } from '../../packages/core/service/local-target/result.ts';
import type { CapabilityResult } from '../../packages/core/service/local-target/types.ts';

import {
  PathAllowlistError,
  validateLocalTargetCallPaths
} from './local-target-path-allowlist.ts';

function resolveDesktopWorktreeRoot(): string {
  const override = process.env.OVERLORD_WORKTREE_ROOT?.trim();
  if (override) return path.resolve(override);
  const home = process.env.OVLD_HOME?.trim() || process.env.OVERLORD_HOME?.trim();
  return path.join(home ? path.resolve(home) : path.join(homedir(), '.ovld'), 'worktrees');
}

function withDesktopDefaults(call: LocalTargetBridgeCall): LocalTargetBridgeCall {
  if (call.capability !== 'listWorktrees') return call;
  const worktreeRoot = call.input.worktreeRoot?.trim()
    ? call.input.worktreeRoot
    : resolveDesktopWorktreeRoot();
  return { ...call, input: { ...call.input, worktreeRoot } };
}

const desktopProvider = new InProcessProvider({
  executionTargetId: null,
  deviceLabel: hostname(),
  transport: 'desktop_bridge'
});

/**
 * Serve a unified local-target capability call from the desktop main process.
 * Paths are allowlisted against linked checkout roots supplied by the renderer.
 */
export async function invokeDesktopLocalTarget(
  call: LocalTargetBridgeCall
): Promise<CapabilityResult<unknown>> {
  try {
    validateLocalTargetCallPaths(call);
  } catch (error) {
    const message =
      error instanceof PathAllowlistError
        ? error.message
        : 'The requested path is not allowed.';
    return fail(desktopProvider.target, 'PERMISSION_DENIED', message);
  }

  return invokeLocalTargetCapability({ provider: desktopProvider, call: withDesktopDefaults(call) });
}

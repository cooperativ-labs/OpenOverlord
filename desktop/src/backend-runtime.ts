import type { BrowserWindow } from 'electron';

import { activeBackendForRenderer, syncOverlordTomlForProfile } from './backend-config.js';
import {
  type ActiveBackend,
  addBackendProfile,
  type BackendProfile,
  getActiveBackendProfileId,
  getBackendProfile,
  listBackendProfiles,
  LOCAL_BACKEND_PROFILE_ID,
  removeBackendProfile,
  resolveActiveBackend,
  sessionPartitionForProfile,
  setActiveBackendProfileId,
  toPublicProfile
} from './backend-profiles.js';
import {
  clearBearerToken,
  clearSessionToken,
  getBearerToken,
  getSessionToken,
  setBearerToken,
  setSessionToken
} from './backend-token-store.js';
import {
  findFreePort,
  startServer,
  stopServer,
  waitForHealth,
  waitForRemoteHealth
} from './server.js';
import { startStaticServer, stopStaticServer } from './static-server.js';

export type BackendRuntimeState = {
  shellOrigin: string;
  active: ActiveBackend;
};

export type BackendRuntimeController = {
  getState: () => BackendRuntimeState;
  reloadForProfile: (profileId: string) => Promise<void>;
};

export function createBackendRuntimeController({
  host,
  preferredPort,
  devConnect,
  devUrl,
  recreateWindow
}: {
  host: string;
  preferredPort: number;
  devConnect: boolean;
  devUrl: string;
  recreateWindow: (args: {
    shellOrigin: string;
    active: ActiveBackend;
  }) => Promise<BrowserWindow | null>;
}): BackendRuntimeController {
  let shellOrigin = devConnect ? new URL(devUrl).origin : `http://${host}:${preferredPort}`;
  let active = resolveActiveBackend({ shellOrigin });

  async function bootServersForActiveProfile(): Promise<boolean> {
    active = resolveActiveBackend({ shellOrigin });
    const profile = getBackendProfile(active.id) ?? getBackendProfile(LOCAL_BACKEND_PROFILE_ID)!;
    syncOverlordTomlForProfile({ profile, shellOrigin: active.shellOrigin });

    if (active.mode === 'local') {
      if (!devConnect) {
        stopStaticServer();
        startServer({ host, port: portOf(active.shellOrigin) });
        return waitForHealth({ host, port: portOf(active.shellOrigin) });
      }
      return waitForHealth({ host: hostOf(active.shellOrigin), port: portOf(active.shellOrigin) });
    }

    stopServer();
    if (!devConnect) {
      startStaticServer({ host, port: portOf(active.shellOrigin) });
    }
    return waitForRemoteHealth({ backendUrl: active.apiBaseUrl });
  }

  return {
    getState: () => ({ shellOrigin, active }),
    reloadForProfile: async profileId => {
      setActiveBackendProfileId(profileId);
      if (!devConnect && profileId === LOCAL_BACKEND_PROFILE_ID) {
        shellOrigin = `http://${host}:${await findFreePort(preferredPort, host)}`;
      }
      active = resolveActiveBackend({ shellOrigin });
      const healthy = await bootServersForActiveProfile();
      if (!healthy) {
        throw new Error(`Could not reach backend for profile ${profileId}`);
      }
      await recreateWindow({ shellOrigin, active });
    }
  };
}

export function listPublicBackends({ shellOrigin }: { shellOrigin: string }) {
  return listBackendProfiles().map(profile => toPublicProfile(profile, { shellOrigin }));
}

export function getPublicActiveBackend({ shellOrigin }: { shellOrigin: string }) {
  const active = resolveActiveBackend({ shellOrigin });
  return activeBackendForRenderer(active);
}

export function addRemoteBackend({
  label,
  backendUrl
}: {
  label: string;
  backendUrl: string;
}): BackendProfile {
  return addBackendProfile({ label, backendUrl });
}

export function removeRemoteBackend(id: string): void {
  clearBearerToken(id);
  removeBackendProfile(id);
}

export function switchActiveBackend({
  id,
  controller
}: {
  id: string;
  controller: BackendRuntimeController;
}): Promise<void> {
  return controller.reloadForProfile(id);
}

export function readSessionTokenForProfile(profileId: string): string | null {
  return getSessionToken(profileId);
}

export function writeSessionTokenForProfile({
  profileId,
  token
}: {
  profileId: string;
  token: string;
}): void {
  setSessionToken({ profileId, token });
}

export function clearSessionTokenForProfile(profileId: string): void {
  clearSessionToken(profileId);
}

export function readBearerTokenForProfile(profileId: string): string | null {
  return getBearerToken(profileId);
}

export function writeBearerTokenForProfile({
  profileId,
  token
}: {
  profileId: string;
  token: string;
}): void {
  setBearerToken({ profileId, token });
}

export function clearBearerTokenForProfile(profileId: string): void {
  clearBearerToken(profileId);
}

export function activeProfilePartition(): string {
  return sessionPartitionForProfile(getActiveBackendProfileId());
}

function hostOf(origin: string): string {
  return new URL(origin).hostname;
}

function portOf(origin: string): number {
  const { port } = new URL(origin);
  return port ? Number(port) : 80;
}

export async function resolveInitialShellOrigin({
  host,
  preferredPort,
  devConnect,
  devUrl
}: {
  host: string;
  preferredPort: number;
  devConnect: boolean;
  devUrl: string;
}): Promise<string> {
  if (devConnect) return new URL(devUrl).origin;
  return `http://${host}:${await findFreePort(preferredPort, host)}`;
}

export { bootServersForProfile };

async function bootServersForProfile({
  active,
  host,
  devConnect
}: {
  active: ActiveBackend;
  host: string;
  devConnect: boolean;
}): Promise<boolean> {
  const profile = getBackendProfile(active.id) ?? getBackendProfile(LOCAL_BACKEND_PROFILE_ID)!;
  syncOverlordTomlForProfile({ profile, shellOrigin: active.shellOrigin });

  if (active.mode === 'local') {
    if (!devConnect) {
      stopStaticServer();
      startServer({ host, port: portOf(active.shellOrigin) });
      return waitForHealth({ host, port: portOf(active.shellOrigin) });
    }
    return waitForHealth({ host: hostOf(active.shellOrigin), port: portOf(active.shellOrigin) });
  }

  stopServer();
  if (!devConnect) {
    startStaticServer({ host, port: portOf(active.shellOrigin) });
  }
  return waitForRemoteHealth({ backendUrl: active.apiBaseUrl });
}

export async function bootActiveBackend({
  shellOrigin,
  host,
  devConnect
}: {
  shellOrigin: string;
  host: string;
  devConnect: boolean;
}): Promise<{ active: ActiveBackend; healthy: boolean }> {
  const active = resolveActiveBackend({ shellOrigin });
  const healthy = await bootServersForProfile({ active, host, devConnect });
  return { active, healthy };
}

export function stopAllBackendServers(): void {
  stopServer();
  stopStaticServer();
}

import type { ClientDeviceIdentity } from '../../packages/core/service/device-identity.ts';

import { isRemoteBackend } from './api-base.ts';

const DEVICE_FINGERPRINT_HEADER = 'x-overlord-device-fingerprint';
const DEVICE_LABEL_HEADER = 'x-overlord-device-label';
const DEVICE_PLATFORM_HEADER = 'x-overlord-device-platform';

const BROWSER_DEVICE_STORAGE_KEY = 'overlord.deviceFingerprint';

let cachedIdentity: ClientDeviceIdentity | null = null;
let loadPromise: Promise<ClientDeviceIdentity> | null = null;

function browserDeviceIdentity(): ClientDeviceIdentity {
  let deviceFingerprint = localStorage.getItem(BROWSER_DEVICE_STORAGE_KEY)?.trim() ?? '';
  if (!deviceFingerprint) {
    deviceFingerprint = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    localStorage.setItem(BROWSER_DEVICE_STORAGE_KEY, deviceFingerprint);
  }
  return {
    deviceFingerprint,
    deviceLabel: 'browser',
    devicePlatform: 'browser'
  };
}

/** Resolve the client machine identity for hosted-backend API calls. */
export async function resolveClientDeviceIdentity(): Promise<ClientDeviceIdentity> {
  if (cachedIdentity) return cachedIdentity;
  if (!loadPromise) {
    loadPromise = (async () => {
      const bridge = window.overlord;
      if (bridge?.getDeviceIdentity) {
        cachedIdentity = await bridge.getDeviceIdentity();
        return cachedIdentity;
      }
      cachedIdentity = browserDeviceIdentity();
      return cachedIdentity;
    })();
  }
  return loadPromise;
}

export function clientDeviceHeaders(
  identity: ClientDeviceIdentity
): Record<string, string> {
  return {
    [DEVICE_FINGERPRINT_HEADER]: identity.deviceFingerprint,
    ...(identity.deviceLabel ? { [DEVICE_LABEL_HEADER]: identity.deviceLabel } : {}),
    ...(identity.devicePlatform ? { [DEVICE_PLATFORM_HEADER]: identity.devicePlatform } : {})
  };
}

export async function remoteBackendDeviceHeaders(): Promise<Record<string, string>> {
  if (!isRemoteBackend()) return {};
  const identity = await resolveClientDeviceIdentity();
  return clientDeviceHeaders(identity);
}

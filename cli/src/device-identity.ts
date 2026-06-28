import { hostname, platform } from 'node:os';

import { deviceIdentityFromParts } from '@overlord/core/service/device-identity';

/** Stable device identity for the machine running the CLI (matches core `devices.ts`). */
export function clientDeviceIdentity(): {
  deviceFingerprint: string;
  deviceLabel: string;
  devicePlatform: string;
} {
  return deviceIdentityFromParts({
    deviceLabel: hostname(),
    devicePlatform: platform()
  });
}

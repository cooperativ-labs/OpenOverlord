import { deviceIdentityFromParts } from '@overlord/core/service/device-identity';
import { hostname, platform } from 'node:os';

/** Stable device identity for the machine running the CLI (matches core `devices.ts`). */
export function clientDeviceIdentity(): {
  deviceFingerprint: string;
  deviceLabel: string;
  devicePlatform: string;
} {
  // Fingerprint stays derived from the real hostname so it remains stable; only the
  // human-facing label is overridable via OVERLORD_DEVICE_LABEL when present.
  const identity = deviceIdentityFromParts({
    deviceLabel: hostname(),
    devicePlatform: platform()
  });
  const labelOverride = process.env.OVERLORD_DEVICE_LABEL?.trim();
  if (labelOverride) {
    identity.deviceLabel = labelOverride;
  }
  return identity;
}

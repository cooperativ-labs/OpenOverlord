import { createHash } from 'node:crypto';

export type DeviceIdentity = {
  deviceFingerprint: string;
  deviceLabel: string;
  devicePlatform: string;
};

/** Optional-label variant used on REST bodies and service context. */
export type ClientDeviceIdentity = {
  deviceFingerprint: string;
  deviceLabel?: string | null;
  devicePlatform?: string | null;
};

/** Stable fingerprint from a device label + platform pair (CLI, desktop, runners). */
export function computeDeviceFingerprint({
  deviceLabel,
  devicePlatform
}: {
  deviceLabel: string;
  devicePlatform: string;
}): string {
  return createHash('sha256')
    .update(`${deviceLabel}:${devicePlatform}`)
    .digest('hex')
    .slice(0, 32);
}

export function deviceIdentityFromParts({
  deviceLabel,
  devicePlatform
}: {
  deviceLabel: string;
  devicePlatform: string;
}): DeviceIdentity {
  return {
    deviceLabel,
    devicePlatform,
    deviceFingerprint: computeDeviceFingerprint({ deviceLabel, devicePlatform })
  };
}

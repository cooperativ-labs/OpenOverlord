import { createHash } from 'node:crypto';
import { hostname, platform } from 'node:os';

/** Stable device identity for the machine running the CLI (matches core `devices.ts`). */
export function clientDeviceIdentity(): {
  deviceFingerprint: string;
  deviceLabel: string;
  devicePlatform: string;
} {
  const devicePlatform = platform();
  const deviceLabel = hostname();
  const deviceFingerprint = createHash('sha256')
    .update(`${deviceLabel}:${devicePlatform}`)
    .digest('hex')
    .slice(0, 32);
  return { deviceFingerprint, deviceLabel, devicePlatform };
}

import type { Request } from 'express';

import type { ClientDeviceIdentity } from '../../packages/core/service/device-identity.ts';

export const DEVICE_FINGERPRINT_HEADER = 'x-overlord-device-fingerprint';
export const DEVICE_LABEL_HEADER = 'x-overlord-device-label';
export const DEVICE_PLATFORM_HEADER = 'x-overlord-device-platform';

export function clientDeviceFromRequest(req: Request): ClientDeviceIdentity | null {
  const deviceFingerprint = req.get(DEVICE_FINGERPRINT_HEADER)?.trim();
  if (!deviceFingerprint) return null;
  return {
    deviceFingerprint,
    deviceLabel: req.get(DEVICE_LABEL_HEADER)?.trim() || null,
    devicePlatform: req.get(DEVICE_PLATFORM_HEADER)?.trim() || null
  };
}

export function clientDeviceFromBody(value: unknown): ClientDeviceIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  const deviceFingerprint =
    typeof body.deviceFingerprint === 'string' ? body.deviceFingerprint.trim() : '';
  if (!deviceFingerprint) return null;
  return {
    deviceFingerprint,
    deviceLabel: typeof body.deviceLabel === 'string' ? body.deviceLabel : null,
    devicePlatform: typeof body.devicePlatform === 'string' ? body.devicePlatform : null
  };
}

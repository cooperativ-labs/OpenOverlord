import { hostname, platform } from 'node:os';

import { deviceIdentityFromParts } from '../../packages/core/service/device-identity.ts';

/** Native device identity shared with the CLI runner on this machine. */
export function readDesktopDeviceIdentity() {
  return deviceIdentityFromParts({
    deviceLabel: hostname(),
    devicePlatform: platform()
  });
}

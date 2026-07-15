import { type Permission } from '@overlord/auth';
import { type Request } from 'express';

import { requireMissionPermission, requireProjectPermission } from '../rbac.ts';

type ResourceRoute = (req: Request) => unknown;

export function projectRoute(permission: Permission, fn: ResourceRoute): ResourceRoute {
  return async req => {
    await requireProjectPermission({ projectId: req.params.projectId, permission });
    return fn(req);
  };
}

export function missionRoute(permission: Permission, fn: ResourceRoute): ResourceRoute {
  return async req => {
    await requireMissionPermission({ missionRef: req.params.missionId, permission });
    return fn(req);
  };
}

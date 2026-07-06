import { type Permission, PERMISSIONS } from '@overlord/auth';
import { type NextFunction, type Request, type Response, Router } from 'express';

import {
  addMissionTime,
  clearEverhourApiKey,
  deleteMissionTime,
  getEverhourIntegration,
  getMissionEverhourState,
  getProjectEverhourLink,
  linkProjectEverhour,
  setEverhourApiKey,
  startMissionTimer,
  stopMissionTimer,
  updateMissionTime
} from './service.ts';

type RouteHandler = (
  fn: (req: Request, res: Response) => unknown,
  options?: { mutates?: boolean; requires?: Permission }
) => (req: Request, res: Response, next: NextFunction) => void;

export function createEverhourExtensionRouter(handle: RouteHandler): Router {
  const router = Router();

  router.get(
    '/integration',
    handle(() => getEverhourIntegration(), { requires: PERMISSIONS.WORKSPACE_READ })
  );
  router.put(
    '/integration',
    handle(req => setEverhourApiKey(String(req.body?.apiKey ?? '')), {
      mutates: true,
      requires: PERMISSIONS.WORKSPACE_UPDATE
    })
  );
  router.delete(
    '/integration',
    handle(() => clearEverhourApiKey(), {
      mutates: true,
      requires: PERMISSIONS.WORKSPACE_UPDATE
    })
  );
  router.put(
    '/projects/:projectId/link',
    handle(
      req => linkProjectEverhour(req.params.projectId, req.body?.everhourProjectName ?? null),
      {
        mutates: true,
        requires: PERMISSIONS.PROJECT_UPDATE
      }
    )
  );
  router.get(
    '/projects/:projectId/link',
    handle(req => getProjectEverhourLink(req.params.projectId), {
      requires: PERMISSIONS.PROJECT_READ
    })
  );
  router.get(
    '/missions/:missionId',
    handle(req => getMissionEverhourState(req.params.missionId), {
      requires: PERMISSIONS.MISSION_READ
    })
  );
  router.post(
    '/missions/:missionId/timer/start',
    handle(req => startMissionTimer(req.params.missionId), {
      mutates: true,
      requires: PERMISSIONS.MISSION_UPDATE
    })
  );
  router.post(
    '/missions/:missionId/timer/stop',
    handle(req => stopMissionTimer(req.params.missionId), {
      mutates: true,
      requires: PERMISSIONS.MISSION_UPDATE
    })
  );
  router.post(
    '/missions/:missionId/time',
    handle(req => addMissionTime(req.params.missionId, req.body), {
      mutates: true,
      requires: PERMISSIONS.MISSION_UPDATE
    })
  );
  router.patch(
    '/missions/:missionId/time/:recordId',
    handle(req => updateMissionTime(req.params.missionId, req.params.recordId, req.body), {
      mutates: true,
      requires: PERMISSIONS.MISSION_UPDATE
    })
  );
  router.delete(
    '/missions/:missionId/time/:recordId',
    handle(req => deleteMissionTime(req.params.missionId, req.params.recordId), {
      mutates: true,
      requires: PERMISSIONS.MISSION_UPDATE
    })
  );

  return router;
}
